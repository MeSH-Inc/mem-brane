import { afterEach, expect, it } from 'vitest';
import { openDatabase } from '../server/db';
import {
  createBrane,
  createTextBlock,
  revisions,
  uid,
  updateBlockLiveState,
} from '../server/services/content';
import { readInputs } from '../server/services/contexts';
import { submitRun, spawnArtifact, readSubmissionReceipt } from '../server/services/runs';
const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function fixture() {
  const db = openDatabase(':memory:');
  databases.push(db);
  const actor = uid();
  db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
    actor,
    'Test',
    `${actor}@test`,
    0,
    0,
  );
  const brane = createBrane(db, actor),
    block = createTextBlock(db, actor, brane.id);
  const limits = {
    models: ['mock'],
    maxTokens: 100,
    userConcurrency: 8,
    maxContextCharacters: 10000,
  };
  return { db, actor, brane, block, limits };
}
it.each(['run', 'spawn'] as const)(
  '%s persists exact no-op and changed edit receipts across later writes and retries',
  (kind) => {
    const { db, actor, brane, block, limits } = fixture();
    const other = createTextBlock(db, actor, brane.id);
    const common = {
      key: uid(),
      braneId: brane.id,
      model: 'mock',
      edits: [
        { blockId: block.id, text: '', version: 0 },
        { blockId: other.id, text: 'Frozen edit', version: 0 },
      ],
    };
    const submit = () =>
      kind === 'run'
        ? submitRun(
            db,
            revisions(db),
            actor,
            { ...common, prompt: 'Test', references: [block.id, other.id] },
            limits,
          )
        : spawnArtifact(
            db,
            revisions(db),
            actor,
            {
              ...common,
              sourceBlockIds: [block.id, other.id],
              anchorPlacementId: block.placement.id,
              action: 'develop',
            },
            limits,
          );
    const run = submit(),
      receipt = readSubmissionReceipt(db, actor, run.id);
    expect(receipt).toEqual({
      runId: run.id,
      outputBlockId: run.output_block_id,
      edits: [
        { blockId: block.id, version: 0, content: { format: 'text', text: '' } },
        { blockId: other.id, version: 1, content: { format: 'text', text: 'Frozen edit' } },
      ],
    });
    updateBlockLiveState(db, actor, { blockId: other.id, text: 'Changed later', version: 1 });
    expect(submit().id).toBe(run.id);
    expect(readSubmissionReceipt(db, actor, run.id)).toEqual(receipt);
    expect(readInputs(db, run.id)[1].content.text).toBe('Frozen edit');
    expect(() => readSubmissionReceipt(db, uid(), run.id)).toThrow('not found');
    expect(() => db.prepare("UPDATE submission_receipts SET receipt_json='{}'").run()).toThrow(
      'immutable',
    );
  },
);
it('rejects changed sources atomically without publishing an earlier edit or a receipt', () => {
  const { db, actor, brane, block, limits } = fixture();
  const other = createTextBlock(db, actor, brane.id);
  updateBlockLiveState(db, actor, { blockId: other.id, text: 'Remote edit', version: 0 });
  expect(() =>
    submitRun(
      db,
      revisions(db),
      actor,
      {
        key: uid(),
        braneId: brane.id,
        model: 'mock',
        prompt: 'Test',
        references: [block.id, other.id],
        edits: [
          { blockId: block.id, text: 'Must roll back', version: 0 },
          { blockId: other.id, text: '', version: 0 },
        ],
      },
      limits,
    ),
  ).toThrow('changed');
  expect(db.prepare('SELECT version FROM block_live_state WHERE block_id=?').get(block.id)).toEqual(
    { version: 0 },
  );
  expect(db.prepare('SELECT * FROM submission_receipts').all()).toEqual([]);
  expect(db.prepare('SELECT * FROM runs').all()).toEqual([]);
});
