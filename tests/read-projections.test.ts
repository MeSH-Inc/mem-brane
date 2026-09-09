import { cancelRun } from '../server/services/run-lifecycle';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openDatabase, type DB } from '../server/db';
import {
  createBrane,
  createTextBlock,
  createPlacement,
  readBrane,
  readRevisionPage,
  revisions,
  updateBlockLiveState,
  uid,
  removePlacement,
} from '../server/services/content';
import { submitRun } from '../server/services/runs';
import { readRunPage } from '../server/services/run-reads';
import { RunWorker } from '../server/jobs/worker';
import { EventHub } from '../server/sse/hub';

let db: DB, actor: string, brane: string;
beforeEach(() => {
  db = openDatabase(':memory:');
  actor = uid();
  db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
    actor,
    'Reader',
    `${actor}@example.com`,
    0,
    0,
  );
  brane = createBrane(db, actor).id;
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

it('orders unique blocks by creation time for stable default focus', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const first = createTextBlock(db, actor, brane);
  vi.mocked(Date.now).mockReturnValue(2000);
  const second = createTextBlock(db, actor, brane);
  createPlacement(db, actor, brane, first.id);
  expect(readBrane(db, actor, brane).blocks.map((b) => b.id)).toEqual([first.id, second.id]);
});

it('pages tied timestamps without duplicates or skips when newer revisions arrive', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const block = createTextBlock(db, actor, brane).id;
  const ids = [];
  for (let version = 0; version < 7; version++) {
    updateBlockLiveState(db, actor, { blockId: block, text: `Text ${version}`, version });
    ids.push(revisions(db).snapshotBlock(actor, block).id);
  }
  const first = readRevisionPage(db, actor, block, 3);
  vi.mocked(Date.now).mockReturnValue(2000);
  updateBlockLiveState(db, actor, { blockId: block, text: 'Arrived after page one', version: 7 });
  revisions(db).snapshotBlock(actor, block);
  const second = readRevisionPage(db, actor, block, 3, first.nextCursor!);
  const third = readRevisionPage(db, actor, block, 3, second.nextCursor!);
  expect([...first.items, ...second.items, ...third.items].map((r) => r.id)).toEqual(
    ids.sort().reverse(),
  );
  expect(third.nextCursor).toBeNull();
  expect(readRevisionPage(db, actor, createTextBlock(db, actor, brane).id)).toEqual({
    items: [],
    nextCursor: null,
  });
  expect(() => readRevisionPage(db, uid(), block, 3)).toThrow('not found');
});

it('projects completed content once and retains failed partials and duplicate placements', async () => {
  const source = createTextBlock(db, actor, brane);
  createPlacement(db, actor, brane, source.id);
  const submit = (prompt: string) =>
    submitRun(
      db,
      revisions(db),
      actor,
      { braneId: brane, key: uid(), model: 'mock', prompt, references: [], edits: [] },
      { models: ['mock'], maxTokens: 100, userConcurrency: 3, maxContextCharacters: 10000 },
    );
  const completed = submit('complete');
  const failed = submit('fail');
  const worker = new RunWorker(
    db,
    new EventHub(),
    async (request, chunk) => {
      if (request.inputs.at(-1)?.content.text === 'fail') {
        chunk('Recoverable partial');
        throw new Error('Fixture failure');
      }
      return { text: 'Final output only once' };
    },
    { concurrency: 2, leaseMs: 5000, checkpointMs: 20, checkpointCharacters: 1 },
  );
  try {
    worker.tick();
    await expect
      .poll(
        () =>
          (
            db
              .prepare("SELECT count(*) n FROM runs WHERE status IN ('completed','failed')")
              .get() as { n: number }
          ).n,
      )
      .toBe(2);
  } finally {
    await worker.stop();
  }
  const state = readBrane(db, actor, brane);
  expect(state.blocks.filter((b) => b.id === source.id)).toHaveLength(1);
  expect(state.placements.filter((p) => p.block_id === source.id)).toHaveLength(2);
  expect(state.runs.find((r) => r.id === completed.id)).toMatchObject({
    partial: '',
    status: 'completed',
  });
  expect(state.runs.find((r) => r.id === failed.id)).toMatchObject({
    partial: 'Recoverable partial',
    status: 'failed',
  });
  expect(JSON.stringify(state).split('Final output only once')).toHaveLength(2);
  expect(state.brane).not.toHaveProperty('owner_id');
  expect(state.placements[0]).not.toHaveProperty('updated_at');
  expect(state.runs[0]).not.toHaveProperty('request_hash');
  expect(state.runs[0]).not.toHaveProperty('options_json');
  expect(db.prepare('SELECT text FROM run_checkpoints WHERE run_id=?').get(completed.id)).toEqual({
    text: 'Final output only once',
  });
});

it('separates removed history from active and cross-brane placed outputs', () => {
  const submit = () =>
    submitRun(
      db,
      revisions(db),
      actor,
      { braneId: brane, key: uid(), model: 'mock', prompt: 'Test', references: [], edits: [] },
      { models: ['mock'], maxTokens: 100, userConcurrency: 3, maxContextCharacters: 10000 },
    );
  const active = submit();
  const old = submit();
  cancelRun(db, actor, old.id);
  for (const run of [active, old]) {
    const p = db.prepare('SELECT id FROM placements WHERE block_id=?').get(run.output_block_id) as {
      id: string;
    };
    removePlacement(db, actor, p.id);
  }
  expect(readBrane(db, actor, brane).runs.map((run) => run.id)).toEqual([active.id]);
  expect(
    readRunPage(db, actor, brane)
      .items.map((run) => run.id)
      .sort(),
  ).toEqual([active.id, old.id].sort());
  const other = createBrane(db, actor).id;
  createPlacement(db, actor, other, active.output_block_id);
  createPlacement(db, actor, other, active.output_block_id);
  expect(readBrane(db, actor, other).runs.map((run) => run.id)).toEqual([active.id]);
  expect(readRunPage(db, actor, other).items).toEqual([]);
  expect(() => readRunPage(db, uid(), brane)).toThrow('not found');
});

it('pages run history across equal timestamps without depending on status', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const run = submitRun(
      db,
      revisions(db),
      actor,
      { braneId: brane, key: uid(), model: 'mock', prompt: 'Page', references: [], edits: [] },
      { models: ['mock'], maxTokens: 100, userConcurrency: 1, maxContextCharacters: 10000 },
    );
    cancelRun(db, actor, run.id);
    ids.push(run.id);
  }
  const first = readRunPage(db, actor, brane, 2);
  const second = readRunPage(db, actor, brane, 2, first.nextCursor!);
  const last = readRunPage(db, actor, brane, 2, second.nextCursor!);
  expect([...first.items, ...second.items, ...last.items].map((run) => run.id)).toEqual(
    ids.sort().reverse(),
  );
  expect(last.nextCursor).toBeNull();
  expect(first.items[0]).not.toHaveProperty('partial');
  expect(() => readRunPage(db, actor, brane, 51)).toThrow('limit');
  expect(() => readRunPage(db, actor, brane, 2, uid())).toThrow('cursor');
});
