import { cancelRun } from '../server/services/run-lifecycle';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { openDatabase, type DB } from '../server/db';
import { createBrane, createTextBlock, revisions, uid } from '../server/services/content';
import { submitRun, retryRun } from '../server/services/runs';
import { readInputs, readLineage } from '../server/services/context-reader';
import { seedHistory } from '../scripts/fixtures/history';
import { estimateRun } from '../server/services/estimate';
import { estimatedInputTokens, priceFor } from '../server/services/costs';
import { RunWorker } from '../server/jobs/worker';
import { EventHub } from '../server/sse/hub';
let db: DB, actor: string, brane: string;
const limits = {
  models: ['mock'],
  maxTokens: 100,
  userConcurrency: 3,
  maxContextCharacters: 100000,
};
beforeEach(() => {
  db = openDatabase(':memory:');
  actor = uid();
  db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
    actor,
    'Context',
    `${actor}@test`,
    0,
    0,
  );
  brane = createBrane(db, actor).id;
});
afterEach(() => db.close());
const submit = () =>
  submitRun(
    db,
    revisions(db),
    actor,
    { braneId: brane, key: uid(), model: 'mock', prompt: 'Frozen', references: [], edits: [] },
    limits,
  );

it('seals a manifest when published and shares it across retries', () => {
  const run = submit(),
    before = readInputs(db, run.id);
  expect(() =>
    db
      .prepare('UPDATE context_manifests SET parent_message_id=NULL WHERE id=?')
      .run(run.context_id),
  ).toThrow('immutable context');
  expect(() =>
    db.prepare('DELETE FROM context_entries WHERE context_id=?').run(run.context_id),
  ).toThrow('immutable context');
  expect(() =>
    db
      .prepare("INSERT INTO context_entries VALUES (?,1,'reference','Late','user',?)")
      .run(run.context_id, before[0].revision_id),
  ).toThrow('sealed context');
  expect(() => db.prepare('UPDATE runs SET context_id=? WHERE id=?').run(uid(), run.id)).toThrow(
    'immutable run request',
  );
  cancelRun(db, actor, run.id);
  const next = retryRun(db, actor, run.id, uid(), limits);
  expect(next.context_id).toBe(run.context_id);
  expect(readInputs(db, next.id)).toEqual(before);
  expect(db.prepare('SELECT count(*) n FROM context_entries').get()).toEqual({ n: 1 });
});

it('rejects foreign revisions and invalid parent/message origins at the database boundary', () => {
  const run = submit();
  const other = uid();
  db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
    other,
    'Other',
    `${other}@test`,
    0,
    0,
  );
  const revision = revisions(db).snapshotBlock(
    other,
    createTextBlock(db, other, createBrane(db, other).id).id,
  );
  const context = uid();
  db.prepare('INSERT INTO context_manifests VALUES (?,?,NULL)').run(context, actor);
  expect(() =>
    db
      .prepare("INSERT INTO context_entries VALUES (?,0,'prompt','Prompt','user',?)")
      .run(context, revision.id),
  ).toThrow('invalid context revision');
  expect(() =>
    db.prepare('INSERT INTO context_manifests VALUES (?,?,?)').run(uid(), actor, uid()),
  ).toThrow('invalid context parent');
  expect(() =>
    db
      .prepare("INSERT INTO conversation_messages VALUES (?,?,NULL,'assistant',?,0,?)")
      .run(uid(), run.conversation_id, readInputs(db, run.id)[0].revision_id, run.id),
  ).toThrow('invalid message origin');
});

it('stores an 80-turn chain linearly while preserving expanded context and estimates', async () => {
  const history = await seedHistory(db, actor, brane, 100, 0);
  expect(history.lineage.map((sample) => sample.storedContextEntries)).toEqual([11, 41, 81]);
  expect(history.lineage.map((sample) => sample.expandedInputs)).toEqual([20, 80, 160]);
  const last = db
    .prepare(
      "SELECT m.id,m.run_id FROM conversation_messages m WHERE role='assistant' ORDER BY created_at DESC,rowid DESC LIMIT 1",
    )
    .get() as { id: string; run_id: string };
  expect(readInputs(db, last.run_id)).toHaveLength(160);
  const lineage = readLineage(db, actor, last.id);
  expect(lineage).toHaveLength(160);
  expect(lineage[0].references).toHaveLength(1);
  expect(lineage[0]).not.toHaveProperty('context_json');
  expect(() => readLineage(db, uid(), last.id)).toThrow('not found');
  const input = {
    braneId: brane,
    key: uid(),
    model: 'mock',
    prompt: 'Next',
    references: [],
    edits: [],
    continueFrom: last.id,
  };
  const policy = { dailyLimitUsd: 1, prices: {} };
  const estimate = estimateRun(db, actor, input, { ...limits, costPolicy: policy });
  const next = submitRun(db, revisions(db), actor, input, limits);
  expect(estimate.estimatedInputTokens).toBe(
    estimatedInputTokens(readInputs(db, next.id), priceFor('mock', policy)),
  );
  expect(db.prepare('SELECT count(*) n FROM context_entries').get()).toEqual({ n: 82 });
});

it('rolls back unpublished manifests and entries when admission fails', () => {
  expect(() =>
    submitRun(
      db,
      revisions(db),
      actor,
      { braneId: brane, key: uid(), model: 'mock', prompt: 'Too large', references: [], edits: [] },
      { ...limits, maxContextCharacters: 1 },
    ),
  ).toThrow('Context is too large');
  for (const table of ['context_entries', 'context_manifests', 'runs', 'blocks', 'block_revisions'])
    expect(db.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({ n: 0 });
});

it('accepts 200 ancestor messages and rejects a longer chain atomically', async () => {
  const worker = new RunWorker(db, new EventHub(), async () => ({ text: 'Output' }), {
    concurrency: 1,
    leaseMs: 5000,
    checkpointMs: 100,
    checkpointCharacters: 100,
  });
  let parent: string | undefined;
  try {
    for (let turn = 0; turn < 101; turn++) {
      const run = submitRun(
        db,
        revisions(db),
        actor,
        {
          braneId: brane,
          key: uid(),
          model: 'mock',
          prompt: 'Turn',
          references: [],
          edits: [],
          continueFrom: parent,
        },
        limits,
      );
      if (turn === 100) expect(readLineage(db, actor, parent!)).toHaveLength(200);
      worker.tick();
      while (
        (db.prepare('SELECT status FROM runs WHERE id=?').get(run.id) as { status: string })
          .status !== 'completed'
      )
        await new Promise<void>((resolve) => setImmediate(resolve));
      parent = (
        db.prepare('SELECT message_id FROM run_outputs WHERE run_id=?').get(run.id) as {
          message_id: string;
        }
      ).message_id;
    }
    const before = db.prepare('SELECT count(*) n FROM context_manifests').get();
    expect(() =>
      submitRun(
        db,
        revisions(db),
        actor,
        {
          braneId: brane,
          key: uid(),
          model: 'mock',
          prompt: 'Beyond limit',
          references: [],
          edits: [],
          continueFrom: parent,
        },
        limits,
      ),
    ).toThrow('lineage is too long');
    expect(db.prepare('SELECT count(*) n FROM context_manifests').get()).toEqual(before);
  } finally {
    await worker.stop();
  }
});
