import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../server/db/index';
import {
  createBrane,
  createTextBlock,
  createPlacement,
  updateBlockLiveState,
  updatePlacementGeometry,
  removePlacement,
  revisions,
  readBrane,
  uid,
} from '../server/services/content';
import { submitRun, readInputs, retryRun, cancelRun } from '../server/services/runs';
import { claimRun, recoverStale, RunWorker } from '../server/jobs/worker';
import { EventHub } from '../server/sse/hub';
import { buildMessages } from '../server/llm/model';
import { requireOwned } from '../server/domain/access';
import type { SubmitRun } from '../shared/types/domain';
let db: DB, actor: string, brane: string, block: string;
const limits = {
  models: ['mock'],
  maxTokens: 100,
  userConcurrency: 10,
  maxContextCharacters: 100000,
};
function input(extra: Partial<SubmitRun> = {}): SubmitRun {
  return {
    braneId: brane,
    key: uid(),
    model: 'mock',
    prompt: 'Explore',
    references: [block],
    edits: [],
    ...extra,
  };
}
function submit(extra: Partial<SubmitRun> = {}) {
  return submitRun(db, revisions(db), actor, input(extra), limits);
}
beforeEach(() => {
  db = openDatabase(':memory:');
  actor = uid();
  db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
    actor,
    'Tester',
    `${actor}@example.com`,
    Date.now(),
    Date.now(),
  );
  brane = createBrane(db, actor).id;
  block = createTextBlock(db, actor, brane).id;
  updateBlockLiveState(db, actor, { blockId: block, text: 'Original thought', version: 0 });
});
afterEach(() => db.close());
describe('immutable content boundary', () => {
  it('preserves older snapshots alongside future ones and refuses SQL mutation', () => {
    const old = revisions(db).snapshotBlock(actor, block);
    updateBlockLiveState(db, actor, { blockId: block, text: 'Edited', version: 1 });
    const next = revisions(db).snapshotBlock(actor, block);
    expect(old.id).not.toBe(next.id);
    expect(old.content.text).toBe('Original thought');
    expect(next.content.text).toBe('Edited');
    expect(() =>
      db.prepare('UPDATE block_revisions SET content_json=? WHERE id=?').run('{}', old.id),
    ).toThrow('immutable revision');
  });
  it('freezes exact revision IDs; editing after submission never changes provider context', () => {
    const run = submit();
    const before = readInputs(db, run.id);
    updateBlockLiveState(db, actor, {
      blockId: block,
      text: 'Different after submission',
      version: 1,
    });
    expect(readInputs(db, run.id)).toEqual(before);
    expect(buildMessages(readInputs(db, run.id))[0].content).toContain('Original thought');
    expect(buildMessages(readInputs(db, run.id))[0].content).not.toContain('Different after');
  });
  it('uses a snapshot service without React/transport structures', () => {
    const calls: string[] = [];
    const service = revisions(db);
    const run = submitRun(
      db,
      {
        snapshotBlock(a, b) {
          calls.push(b);
          return service.snapshotBlock(a, b);
        },
      },
      actor,
      input(),
      limits,
    );
    expect(calls[0]).toBe(block);
    expect(calls).toHaveLength(2);
    expect(readInputs(db, run.id)[0].revision_id).toBeTruthy();
  });
  it('flushes edits atomically and rolls back on stale versions', () => {
    const run = submit({ edits: [{ blockId: block, text: 'Flushed at submit', version: 1 }] });
    expect(readInputs(db, run.id)[0].content.text).toBe('Flushed at submit');
    expect(() => submit({ edits: [{ blockId: block, text: 'Stale', version: 1 }] })).toThrow(
      'changed',
    );
    expect((db.prepare('SELECT count(*) n FROM runs').get() as any).n).toBe(1);
  });
  it('rejects mutated frozen inputs and request parameters', () => {
    const run = submit();
    expect(() =>
      db.prepare('UPDATE run_inputs SET label=? WHERE run_id=?').run('changed', run.id),
    ).toThrow('immutable');
    expect(() => db.prepare('UPDATE runs SET model=? WHERE id=?').run('new', run.id)).toThrow(
      'immutable',
    );
  });
});
describe('placements and explicit context', () => {
  it('moves geometry without touching content or creating revisions', () => {
    const p = (readBrane(db, actor, brane).placements as any[])[0];
    updatePlacementGeometry(db, actor, p.id, { x: 999, y: -100, width: 400, height: 200 });
    expect((db.prepare('SELECT count(*) n FROM block_revisions').get() as any).n).toBe(0);
    expect(readBrane(db, actor, brane).blocks[0].content.text).toBe('Original thought');
  });
  it('reuses one block twice and across branes, then removes only its placement', () => {
    const other = createBrane(db, actor).id;
    const p = createPlacement(db, actor, other, block);
    createPlacement(db, actor, brane, block);
    expect(readBrane(db, actor, brane).placements).toHaveLength(2);
    removePlacement(db, actor, p.id);
    expect(readBrane(db, actor, other).placements).toHaveLength(0);
    expect(requireOwned(db, 'blocks', actor, block).id).toBe(block);
  });
  it('preserves explicit reference order and ignores proximity', () => {
    const second = createTextBlock(db, actor, brane).id;
    updateBlockLiveState(db, actor, { blockId: second, text: 'Second', version: 0 });
    const run = submit({ references: [second, block] });
    expect(readInputs(db, run.id).map((i) => i.content.text)).toEqual([
      'Second',
      'Original thought',
      'Explore',
    ]);
    const noContext = submit({ references: [] });
    expect(readInputs(db, noContext.id)).toHaveLength(1);
  });
});
describe('run cost and lifecycle', () => {
  it('deduplicates identical keys and rejects changed payloads', () => {
    const request = input();
    const a = submitRun(db, revisions(db), actor, request, limits),
      b = submitRun(db, revisions(db), actor, request, limits);
    expect(a.id).toBe(b.id);
    expect(() =>
      submitRun(db, revisions(db), actor, { ...request, prompt: 'Different' }, limits),
    ).toThrow('different request');
    expect((db.prepare('SELECT count(*) n FROM block_revisions').get() as any).n).toBe(2);
  });
  it('enforces model allowlist and output limits', () => {
    expect(() => submit({ model: 'unapproved' })).toThrow('not allowed');
    const r = submit({ maxOutputTokens: 999999 });
    expect(JSON.parse(r.options_json).maxOutputTokens).toBe(100);
  });
  it('atomically claims once and recovers claimed versus running leases differently', () => {
    const a = submit();
    expect(claimRun(db, 'worker-a', 1000).id).toBe(a.id);
    expect(claimRun(db, 'worker-b', 1000)).toBeNull();
    db.prepare('UPDATE runs SET lease_until=0 WHERE id=?').run(a.id);
    recoverStale(db);
    expect(claimRun(db, 'worker-b', 1000).id).toBe(a.id);
    db.prepare("UPDATE runs SET status='running',lease_until=0 WHERE id=?").run(a.id);
    recoverStale(db);
    expect(requireOwned(db, 'runs', actor, a.id).status).toBe('interrupted');
    expect(claimRun(db, 'worker-c', 1000)).toBeNull();
  });
  it('explicit retry is traceable and reuses exact historical revisions', () => {
    const old = submit();
    db.prepare("UPDATE runs SET status='interrupted' WHERE id=?").run(old.id);
    updateBlockLiveState(db, actor, { blockId: block, text: 'New edits', version: 1 });
    const key = uid(),
      next = retryRun(db, actor, old.id, key, limits);
    expect(next.retry_of).toBe(old.id);
    expect(readInputs(db, next.id).map((i) => i.revision_id)).toEqual(
      readInputs(db, old.id).map((i) => i.revision_id),
    );
    expect(retryRun(db, actor, old.id, key, limits).id).toBe(next.id);
  });
  it('cancels queued work without invoking the provider', () => {
    const r = submit();
    cancelRun(db, actor, r.id);
    expect(requireOwned(db, 'runs', actor, r.id).status).toBe('cancelled');
    expect(claimRun(db, 'w', 1000)).toBeNull();
  });
});
async function complete(runId: string, text = 'Final response') {
  const worker = new RunWorker(
    db,
    new EventHub(),
    async (req, chunk) => {
      chunk('partial');
      return { text, usage: { inputTokens: 4, outputTokens: 5 } };
    },
    { concurrency: 1, leaseMs: 5000, checkpointMs: 20, checkpointCharacters: 1 },
  );
  worker.tick();
  await expect.poll(() => requireOwned(db, 'runs', actor, runId).status).toBe('completed');
  await worker.stop();
  return db.prepare('SELECT * FROM run_outputs WHERE run_id=?').get(runId) as any;
}
describe('worker, branch semantics and reconnect', () => {
  it('finalizes durable output even without any SSE listener, and reconstructs on reload', async () => {
    const r = submit();
    await complete(r.id);
    const state = readBrane(db, actor, brane);
    expect(state.blocks.find((b) => b.id === r.output_block_id)?.content.text).toBe(
      'Final response',
    );
    expect((state.runs[0] as any).status).toBe('completed');
    expect((state.runs[0] as any).usage_json).toContain('inputTokens');
  });
  it('keeps failed partial output separate from immutable revisions', async () => {
    const r = submit();
    const worker = new RunWorker(
      db,
      new EventHub(),
      async (_, chunk) => {
        chunk('Incomplete');
        throw new Error('lost connection');
      },
      { concurrency: 1, leaseMs: 5000, checkpointMs: 20, checkpointCharacters: 1 },
    );
    worker.tick();
    await expect.poll(() => requireOwned(db, 'runs', actor, r.id).status).toBe('failed');
    await worker.stop();
    expect(
      (db.prepare('SELECT text FROM run_checkpoints WHERE run_id=?').get(r.id) as any).text,
    ).toBe('Incomplete');
    expect(db.prepare('SELECT * FROM run_outputs WHERE run_id=?').get(r.id)).toBeUndefined();
    expect(() => revisions(db).snapshotBlock(actor, r.output_block_id)).toThrow('finalized');
  });
  it('distinguishes continuing a lineage from synthesis of independent responses', async () => {
    const a = submit(),
      ao = await complete(a.id, 'Branch A');
    const b = submit(),
      bo = await complete(b.id, 'Branch B');
    const continuation = submit({ references: [], continueFrom: ao.message_id });
    const ci = readInputs(db, continuation.id);
    expect(ci.some((i) => i.kind === 'lineage' && i.content.text === 'Branch A')).toBe(true);
    expect(ci.some((i) => i.content.text === 'Branch B')).toBe(false);
    expect(
      ci.some((i) => i.kind === 'lineage_reference' && i.content.text === 'Original thought'),
    ).toBe(true);
    const synthesis = submit({ references: [a.output_block_id, b.output_block_id] });
    const si = readInputs(db, synthesis.id);
    expect(si.map((i) => i.kind)).toEqual(['reference', 'reference', 'prompt']);
    expect(si.slice(0, 2).map((i) => i.revision_id)).toEqual([ao.revision_id, bo.revision_id]);
  });
  it('shutdown interrupts running requests without finalizing partial text', async () => {
    const r = submit();
    const worker = new RunWorker(
      db,
      new EventHub(),
      async (req, chunk) => {
        chunk('Working');
        await new Promise((_, reject) =>
          req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true }),
        );
        return { text: 'impossible' };
      },
      { concurrency: 1, leaseMs: 5000, checkpointMs: 20, checkpointCharacters: 1 },
    );
    worker.tick();
    await worker.stop();
    expect(requireOwned(db, 'runs', actor, r.id).status).toBe('interrupted');
    expect(db.prepare('SELECT * FROM run_outputs WHERE run_id=?').get(r.id)).toBeUndefined();
  });
});
it('enforces ownership on branes, blocks, runs and assets', () => {
  const other = uid(),
    r = submit();
  expect(() => readBrane(db, other, brane)).toThrow('not found');
  expect(() => revisions(db).snapshotBlock(other, block)).toThrow('not found');
  expect(() => cancelRun(db, other, r.id)).toThrow('not found');
  const asset = uid();
  db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?)').run(
    asset,
    actor,
    asset,
    'image/png',
    12,
    Date.now(),
  );
  expect(() => requireOwned(db, 'assets', other, asset)).toThrow('not found');
  expect(() => createPlacement(db, other, brane, block)).toThrow('not found');
});
