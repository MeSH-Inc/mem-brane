import { cancelRun } from '../server/services/run-lifecycle';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDatabase, type DB } from '../server/db/index';
import { createBrane, revisions, uid } from '../server/services/content';
import { submitRun, retryRun } from '../server/services/runs';
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
  queueLimit: 100,
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
  const preview = estimateRun(db, actor, input(), limits);
  expect(preview.reservedMicrousd).toBeGreaterThan(0);
  expect((db.prepare('SELECT count(*) n FROM block_revisions').get() as any).n).toBe(before);
  expect((db.prepare('SELECT count(*) n FROM runs').get() as any).n).toBe(0);
  const run = submitRun(db, revisions(db), actor, input(), limits);
  expect(() =>
    db.prepare('UPDATE run_costs SET reserved_microusd=0 WHERE run_id=?').run(run.id),
  ).toThrow('immutable');
});
it('vision capability is enforced before queueing any paid work', async () => {
  const asset = uid();
  db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?,?)').run(
    asset,
    actor,
    asset,
    'image/png',
    1,
    0,
    'a'.repeat(64),
  );
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
      assetId: asset,
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

it.each([
  undefined,
  {},
  { inputTokens: 1 },
  { inputTokens: -1, outputTokens: 0 },
  { inputTokens: NaN, outputTokens: 1 },
  { inputTokens: 1.5, outputTokens: 1 },
  { inputTokens: 1, outputTokens: Infinity },
  { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: Number.MAX_SAFE_INTEGER },
])('retains liability for missing, invalid or overflowing usage %j', (usage) => {
  const run = submitRun(db, revisions(db), actor, input(), limits);
  settleCost(db, run.id, usage);
  expect(
    db.prepare('SELECT status,confirmed_microusd FROM run_costs WHERE run_id=?').get(run.id),
  ).toEqual({ status: 'uncertain', confirmed_microusd: null });
  expect(budgetState(db, actor, policy).committedMicrousd).toBeGreaterThan(0);
});
it('settles using its frozen price despite subsequent policy changes', () => {
  const run = submitRun(db, revisions(db), actor, input(), limits);
  const original = policy.prices['test-model'];
  policy.prices['test-model'] = { ...original, inputUsdPerMillion: 100 };
  try {
    settleCost(db, run.id, { inputTokens: 20, outputTokens: 10 });
    expect(
      db.prepare('SELECT confirmed_microusd FROM run_costs WHERE run_id=?').get(run.id),
    ).toEqual({ confirmed_microusd: 40 });
  } finally {
    policy.prices['test-model'] = original;
  }
});
it.each(['{"inputUsdPerMillion":-1}', 'not json'])(
  'rejects corrupt stored pricing before settlement: %s',
  (pricing) => {
    const run = submitRun(db, revisions(db), actor, input(), limits);
    db.exec('DROP TRIGGER immutable_cost_estimate');
    db.prepare('UPDATE run_costs SET pricing_json=? WHERE run_id=?').run(pricing, run.id);
    expect(() => settleCost(db, run.id, { inputTokens: 1, outputTokens: 1 })).toThrow();
    expect(db.prepare('SELECT status FROM run_costs WHERE run_id=?').get(run.id)).toEqual({
      status: 'reserved',
    });
  },
);
it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid reconciliation amount %s without an audit entry',
  async (amount) => {
    const { reconcileUncertainCost } = await import('../server/services/costs');
    const run = submitRun(db, revisions(db), actor, input(), limits);
    holdUncertainCost(db, run.id);
    expect(() => reconcileUncertainCost(db, run.id, amount, 'Provider invoice')).toThrow();
    expect(db.prepare('SELECT * FROM run_cost_reconciliations').all()).toEqual([]);
  },
);
it('rolls reconciliation back if audit persistence fails', async () => {
  const { reconcileUncertainCost } = await import('../server/services/costs');
  const run = submitRun(db, revisions(db), actor, input(), limits);
  holdUncertainCost(db, run.id);
  db.exec(
    "CREATE TRIGGER fail_audit BEFORE INSERT ON run_cost_reconciliations BEGIN SELECT RAISE(ABORT,'audit failure'); END",
  );
  expect(() => reconcileUncertainCost(db, run.id, 10, 'Provider invoice')).toThrow('audit failure');
  expect(
    db.prepare('SELECT status,confirmed_microusd FROM run_costs WHERE run_id=?').get(run.id),
  ).toEqual({ status: 'uncertain', confirmed_microusd: null });
});
it('rejects aggregate liability beyond the JavaScript integer range without rounding', async () => {
  const { reconcileUncertainCost } = await import('../server/services/costs');
  const first = submitRun(db, revisions(db), actor, input(), limits);
  const second = submitRun(db, revisions(db), actor, input(), limits);
  for (const run of [first, second]) holdUncertainCost(db, run.id);
  reconcileUncertainCost(db, first.id, Number.MAX_SAFE_INTEGER, 'Provider invoice');
  reconcileUncertainCost(db, second.id, 1, 'Provider invoice');
  expect(() => budgetState(db, actor, policy)).toThrow('safe integer range');
});
it.each([
  { confirmed_microusd: -1, status: 'confirmed' },
  { confirmed_microusd: 0.5, status: 'confirmed' },
  { confirmed_microusd: Number.MAX_SAFE_INTEGER + 1, status: 'confirmed' },
  { confirmed_microusd: null, status: 'confirmed' },
  { confirmed_microusd: 1, status: 'uncertain' },
])('rejects malformed accounting records %j', async (value) => {
  const { readRunCost } = await import('../server/db/records');
  const run = submitRun(db, revisions(db), actor, input(), limits);
  db.prepare('UPDATE run_costs SET status=?,confirmed_microusd=? WHERE run_id=?').run(
    value.status,
    value.confirmed_microusd,
    run.id,
  );
  expect(() => readRunCost(db, run.id)).toThrow('Invalid database record');
});
it.each([
  { inputUsdPerMillion: NaN },
  { inputUsdPerMillion: Infinity },
  { imageTokenBound: -1 },
  { vision: true, imageTokenBound: 0 },
  { source: '' },
  { verifiedAt: '2026-02-30' },
])('rejects invalid pricing at admission without reserving %j', (change) => {
  const badPolicy = {
    ...policy,
    prices: { 'test-model': { ...policy.prices['test-model'], ...change } },
  };
  expect(() =>
    submitRun(db, revisions(db), actor, input(), { ...limits, costPolicy: badPolicy }),
  ).toThrow();
  expect(db.prepare('SELECT * FROM run_costs').all()).toEqual([]);
  expect(db.prepare('SELECT * FROM runs').all()).toEqual([]);
});
