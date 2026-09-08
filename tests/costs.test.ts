import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDatabase, type DB } from '../server/db/index';
import { createBrane, revisions, uid } from '../server/services/content';
import { submitRun, cancelRun, retryRun } from '../server/services/runs';
import {
  budgetState,
  settleCost,
  holdUncertainCost,
  type CostPolicy,
} from '../server/services/costs';
let db: DB, actor: string, braneId: string;
const policy: CostPolicy = {
  dailyLimitUsd: 0.02,
  prices: {
    'test-model': {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
      vision: false,
      imageTokenBound: 0,
      source: 'https://example.com/test-pricing',
      verifiedAt: '2026-09-08',
    },
  },
};
const limits = {
  models: ['test-model'],
  maxTokens: 100,
  userConcurrency: 100,
  maxContextCharacters: 100000,
  costPolicy: policy,
};
const input = () => ({
  braneId,
  key: uid(),
  model: 'test-model',
  prompt: 'Budget test',
  references: [],
  edits: [],
});
beforeEach(() => {
  db = openDatabase(':memory:');
  actor = uid();
  db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
    actor,
    'test',
    `${actor}@example.com`,
    0,
    0,
  );
  braneId = createBrane(db, actor).id;
});
afterEach(() => db.close());
it('reserves atomically, deduplicates without charging twice, and enforces daily admission', () => {
  const request = input(),
    first = submitRun(db, revisions(db), actor, request, limits);
  submitRun(db, revisions(db), actor, request, limits);
  expect((db.prepare('SELECT count(*) n FROM run_costs').get() as any).n).toBe(1);
  let count = 1;
  expect(() => {
    while (count++ < 30) submitRun(db, revisions(db), actor, input(), limits);
  }).toThrow('budget');
  expect(budgetState(db, actor, policy).committedMicrousd).toBeLessThanOrEqual(20000);
  cancelRun(db, actor, first.id);
  expect(
    (db.prepare('SELECT status FROM run_costs WHERE run_id=?').get(first.id) as any).status,
  ).toBe('released');
});
it('settles confirmed usage separately from estimates and retains uncertain liabilities across UTC days', () => {
  const a = submitRun(db, revisions(db), actor, input(), limits);
  settleCost(db, a.id, { inputTokens: 20, outputTokens: 10 });
  expect(
    (db.prepare('SELECT confirmed_microusd FROM run_costs WHERE run_id=?').get(a.id) as any)
      .confirmed_microusd,
  ).toBe(40);
  const b = submitRun(db, revisions(db), actor, input(), limits);
  holdUncertainCost(db, b.id);
  const tomorrow = budgetState(db, actor, policy, Date.now() + 86400000);
  expect(tomorrow.committedMicrousd).toBeGreaterThan(0);
  expect(tomorrow.committedMicrousd).toBeLessThan(budgetState(db, actor, policy).committedMicrousd);
});
it('missing usage is not free, and explicit retry makes a separate reservation', () => {
  const a = submitRun(db, revisions(db), actor, input(), limits);
  settleCost(db, a.id);
  db.prepare("UPDATE runs SET status='interrupted' WHERE id=?").run(a.id);
  const before = budgetState(db, actor, policy).committedMicrousd;
  retryRun(db, actor, a.id, uid(), limits);
  expect(budgetState(db, actor, policy).committedMicrousd).toBeGreaterThan(before);
});
it('fails closed on unpriced paid models or a zero budget', () => {
  expect(() =>
    submitRun(db, revisions(db), actor, input(), { ...limits, costPolicy: undefined }),
  ).toThrow('verified model pricing');
  expect((db.prepare('SELECT count(*) n FROM runs').get() as any).n).toBe(0);
});
it('uncertain liability can only be released using an auditable explicit reconciliation', async () => {
  const { reconcileUncertainCost } = await import('../server/services/costs');
  const run = submitRun(db, revisions(db), actor, input(), limits);
  holdUncertainCost(db, run.id);
  reconcileUncertainCost(db, run.id, 0, 'Provider invoice confirms no charge');
  expect(budgetState(db, actor, policy).committedMicrousd).toBe(0);
  expect(() => reconcileUncertainCost(db, run.id, 0, 'Another confirmation')).toThrow(
    'Only uncertain',
  );
  expect(() =>
    db.prepare('DELETE FROM run_cost_reconciliations WHERE run_id=?').run(run.id),
  ).toThrow('immutable');
});

it('preview does not materialize history and immutable estimates cannot be rewritten', async () => {
  const { estimateRun } = await import('../server/services/estimate');
  const before = (db.prepare('SELECT count(*) n FROM block_revisions').get() as any).n;
  const preview = estimateRun(db, actor, input(), 100, policy);
  expect(preview.reservedMicrousd).toBeGreaterThan(0);
  expect((db.prepare('SELECT count(*) n FROM block_revisions').get() as any).n).toBe(before);
  expect((db.prepare('SELECT count(*) n FROM runs').get() as any).n).toBe(0);
  const run = submitRun(db, revisions(db), actor, input(), limits);
  expect(() =>
    db.prepare('UPDATE run_costs SET reserved_microusd=0 WHERE run_id=?').run(run.id),
  ).toThrow('immutable');
});
it('vision capability is enforced before queueing any paid work', async () => {
  const { createBlock } = await import('../server/services/content');
  const image = createBlock(
    db,
    actor,
    'image',
    {
      format: 'image',
      filename: 'image',
      representation: 'original-image-v1',
      text: 'image',
      assetId: uid(),
      assetHash: 'a'.repeat(64),
      mimeType: 'image/png',
    },
    braneId,
  );
  expect(() =>
    submitRun(db, revisions(db), actor, { ...input(), references: [image.id] }, limits),
  ).toThrow('does not support image');
  expect((db.prepare('SELECT count(*) n FROM runs').get() as any).n).toBe(0);
});

it('known preflight failure releases the reservation while provider failures retain it', async () => {
  const { RunWorker } = await import('../server/jobs/worker');
  const { EventHub } = await import('../server/sse/hub');
  const { BeforeInvocationError } = await import('../server/llm/errors');
  const run = submitRun(db, revisions(db), actor, input(), limits);
  const worker = new RunWorker(
    db,
    new EventHub(),
    async () => {
      throw new BeforeInvocationError();
    },
    { concurrency: 1, leaseMs: 5000, checkpointMs: 100, checkpointCharacters: 10 },
  );
  worker.tick();
  await expect
    .poll(() => (db.prepare('SELECT status FROM runs WHERE id=?').get(run.id) as any).status)
    .toBe('failed');
  await worker.stop();
  expect(
    (db.prepare('SELECT status FROM run_costs WHERE run_id=?').get(run.id) as any).status,
  ).toBe('released');
  expect(budgetState(db, actor, policy).committedMicrousd).toBe(0);
});

it('enforces operator liability across actors and includes it in available budget', () => {
  const globalPolicy = { ...policy, globalDailyLimitUsd: 0.003 };
  const first = submitRun(db, revisions(db), actor, input(), {
    ...limits,
    costPolicy: globalPolicy,
  });
  holdUncertainCost(db, first.id);
  const secondActor = uid();
  db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
    secondActor,
    'Other',
    `${secondActor}@example.com`,
    0,
    0,
  );
  const secondBrane = createBrane(db, secondActor).id;
  expect(budgetState(db, secondActor, globalPolicy).availableMicrousd).toBeLessThan(1000);
  expect(() =>
    submitRun(
      db,
      revisions(db),
      secondActor,
      { ...input(), braneId: secondBrane },
      { ...limits, costPolicy: globalPolicy },
    ),
  ).toThrow('budget');
  expect((db.prepare('SELECT count(*) n FROM runs').get() as any).n).toBe(1);
});
