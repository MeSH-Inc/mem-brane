import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openDatabase, type DB } from '../server/db';
import {
  createBrane,
  createBlock,
  revisions,
  uid,
  updateBlockLiveState,
} from '../server/services/content';
import { contextReader, readInputs, readLineage } from '../server/services/context-reader';
import { contentReader } from '../server/services/representations';
import { submitRun } from '../server/services/runs';
import { claimRun, startAttempt, completeAttempt } from '../server/services/run-lifecycle';
import { planRun } from '../server/services/run-plan';
let db: DB, actor: string, other: string, braneId: string;
const limits = {
  models: ['mock'],
  maxTokens: 100,
  userConcurrency: 10,
  maxContextCharacters: 1000000,
};
beforeEach(() => {
  db = openDatabase(':memory:');
  actor = uid();
  other = uid();
  for (const id of [actor, other])
    db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
      id,
      'Reader',
      `${id}@test`,
      0,
      0,
    );
  braneId = createBrane(db, actor).id;
});
afterEach(() => db.close());
function image(owner = actor, label = 'Image') {
  const asset = uid();
  const digest = asset.replaceAll('-', '').padEnd(64, '0');
  db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?,?)').run(
    asset,
    owner,
    asset,
    'image/png',
    1,
    0,
    digest,
  );
  return createBlock(db, owner, 'image', {
    format: 'image',
    filename: label,
    text: label,
    representation: 'original-image-v1',
    assetId: asset,
    assetHash: digest,
    mimeType: 'image/png',
  });
}
function measure<T>(read: () => T) {
  const queries: string[] = [],
    prepare = db.prepare.bind(db);
  const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
    queries.push(sql);
    return prepare(sql);
  }) as typeof db.prepare);
  try {
    return { value: read(), queries };
  } finally {
    spy.mockRestore();
  }
}
function submit(references: string[]) {
  return submitRun(
    db,
    revisions(db),
    actor,
    { braneId, key: uid(), model: 'mock', prompt: 'Explore', references, edits: [] },
    limits,
  );
}
function complete(id: string) {
  claimRun(db, 'worker', 1000);
  const token = startAttempt(db, id, 'worker')!;
  expect(completeAttempt(db, token, { text: 'Answer' })).toBe(true);
  return db
    .prepare<unknown[], { message_id: string }>('SELECT message_id FROM run_outputs WHERE run_id=?')
    .get(id)!.message_id;
}
it('uses constant query counts for 1, 32, and 200 distinct image references', () => {
  const blocks = Array.from({ length: 200 }, (_, i) => image(actor, `Image ${i}`).id);
  const samples = [1, 32, 200].map((count) =>
    measure(() => contextReader(db, actor).plan(blocks.slice(0, count), [])),
  );
  expect(samples.map((sample) => sample.queries.length)).toEqual([2, 2, 2]);
  for (const [index, sample] of samples.entries()) {
    expect(sample.queries.filter((sql) => sql.includes('FROM asset_representations'))).toHaveLength(
      1,
    );
    expect([...sample.value.candidates.keys()]).toEqual(blocks.slice(0, [1, 32, 200][index]));
  }
});
it('batches editable blocks without per-edit queries and does not persist drafts', () => {
  const blocks = Array.from(
    { length: 64 },
    () => createBlock(db, actor, 'text', { format: 'text', text: 'Original' }).id,
  );
  const planned = measure(() =>
    contextReader(db, actor).plan(
      blocks,
      blocks.map((blockId) => ({ blockId, version: 0, text: 'Draft' })),
    ),
  );
  expect(planned.queries).toHaveLength(1);
  expect(
    [...planned.value.candidates.values()].every((candidate) => candidate.content.text === 'Draft'),
  ).toBe(true);
  expect(db.prepare('SELECT DISTINCT version FROM block_live_state').all()).toEqual([
    { version: 0 },
  ]);
  expect(db.prepare('SELECT * FROM block_revisions').all()).toEqual([]);
});
it('hydrates lineage and local images in a single representation query without losing duplicates or order', () => {
  const a = image(actor, 'A').id,
    b = image(actor, 'B').id;
  const first = submit([b, a, b]);
  const parent = complete(first.id);
  const planned = measure(() => contextReader(db, actor).plan([a, b, a], [], parent));
  expect(planned.queries).toHaveLength(4);
  expect(planned.queries.filter((sql) => sql.includes('FROM asset_representations'))).toHaveLength(
    1,
  );
  expect(planned.value.inputs.slice(0, 3).map((input) => input.content.text)).toEqual([
    'B',
    'A',
    'B',
  ]);
  expect(planned.value.inputs.slice(0, 3).map((input) => input.label)).toEqual([
    'Reference 1',
    'Reference 2',
    'Reference 3',
  ]);
  const next = submitRun(
    db,
    revisions(db),
    actor,
    {
      braneId,
      key: uid(),
      model: 'mock',
      prompt: 'Next',
      continueFrom: parent,
      references: [a, b, a],
      edits: [],
    },
    limits,
  );
  const committed = measure(() => readInputs(db, next.id));
  expect(
    committed.queries.filter((sql) => sql.includes('FROM asset_representations')),
  ).toHaveLength(1);
  expect(committed.value.map((input) => input.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  expect(
    committed.value
      .filter((input) => input.kind === 'reference')
      .map((input) => input.content.text),
  ).toEqual(['A', 'B', 'A']);
  expect(
    committed.value
      .filter((input) => input.kind === 'lineage_reference')
      .map((input) => input.content.text),
  ).toEqual(['B', 'A', 'B']);
});
it('keeps planning query count fixed as the current reference set grows alongside lineage', () => {
  const blocks = Array.from({ length: 32 }, (_, i) => image(actor, String(i)).id);
  const parent = complete(submit([blocks[0], blocks[1]]).id);
  const samples = [1, 32].map((count) =>
    measure(() =>
      planRun(
        db,
        actor,
        {
          braneId,
          key: uid(),
          model: 'mock',
          prompt: 'Next',
          continueFrom: parent,
          references: blocks.slice(0, count),
          edits: [],
        },
        limits,
      ),
    ),
  );
  expect(samples[0].queries.length).toBe(samples[1].queries.length);
  expect(samples[0].queries).toHaveLength(5);
});
it.each(['missing', 'foreign'])(
  'rejects mixed owned and %s blocks before hydrating any representation',
  (kind) => {
    const own = image().id,
      inaccessible = kind === 'foreign' ? image(other).id : uid();
    const sample = measure(() =>
      expect(() => contextReader(db, actor).plan([own, inaccessible], [])).toThrow('not found'),
    );
    expect(sample.queries.filter((sql) => sql.includes('FROM asset_representations'))).toHaveLength(
      0,
    );
  },
);
it('rejects foreign edits, lineage, and representation identities', () => {
  const foreign = createBlock(db, other, 'text', { format: 'text', text: 'Private' }).id;
  expect(() =>
    contextReader(db, actor).plan([], [{ blockId: foreign, version: 0, text: 'Changed' }]),
  ).toThrow('not found');
  const parent = complete(submit([]).id);
  expect(() => readLineage(db, other, parent)).toThrow('not found');
  const foreignImage = image(other).id;
  const stored = db
    .prepare<unknown[], { content_json: string }>(
      'SELECT content_json FROM block_live_state WHERE block_id=?',
    )
    .get(foreignImage)!;
  expect(() => contentReader(db, actor, 'full').prefetch([stored.content_json])).toThrow(
    'not found',
  );
});
it('decodes block state before planning instead of trusting a row assertion', () => {
  const block = createBlock(db, actor, 'text', { format: 'text', text: 'Original' }).id;
  db.prepare('UPDATE block_live_state SET version=? WHERE block_id=?').run('corrupt', block);
  expect(() => contextReader(db, actor).plan([block], [])).toThrow('Invalid database record');
});
it('does not retain mutable block state between requests', () => {
  const block = createBlock(db, actor, 'text', { format: 'text', text: 'Before' }).id;
  expect(contextReader(db, actor).plan([block], []).candidates.get(block)!.content.text).toBe(
    'Before',
  );
  updateBlockLiveState(db, actor, { blockId: block, version: 0, text: 'After' });
  expect(contextReader(db, actor).plan([block], []).candidates.get(block)!.content.text).toBe(
    'After',
  );
});
