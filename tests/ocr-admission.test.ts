import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openDatabase, type DB } from '../server/db';
import {
  uid,
  createBrane,
  revisions,
  createBlock,
  readRevision,
  readBrane,
} from '../server/services/content';
import { OcrWorker } from '../server/jobs/ocr-worker';
import { submitRun } from '../server/services/runs';
import { budgetState } from '../server/services/costs';
import { committedSpend } from '../server/services/spend';
import {
  OcrService,
  grantOcrCredits,
  ocrCredits,
  defaultOcrLimits,
  type OcrProvider,
  type OcrLimits,
} from '../server/services/ocr';
import type { AssetStore } from '../server/storage/assets';
import { pdfFixture } from './fixtures/pdf';
import { ocrResult } from './fixtures/ocr';
import { createApi } from '../server/api';
import { EventHub } from '../server/sse/hub';
import type { createAuth } from '../server/auth';
let db: DB, actor: string, dir: string, path: string;
const objects = new Map<string, Uint8Array>();
const store: AssetStore = {
  put: async (id, bytes) => {
    objects.set(id, bytes);
  },
  get: async (id) => objects.get(id)!,
  delete: async (id) => {
    objects.delete(id);
  },
  createReadUrl: async () => '',
};
const policy = {
  provider: 'test',
  model: 'ocr-test',
  version: 'frozen-1',
  microusdPerPage: 4000,
  priceSource: 'https://example.com/ocr-pricing',
  verifiedAt: '2026-09-10',
  options: {},
};
const limits: OcrLimits = {
  ...defaultOcrLimits,
  globalDailyLimitUsd: 10,
  globalMonthlyLimitUsd: 100,
};
const parse = vi.fn<OcrProvider['parse']>(async ({ pages }) => ({
  billedPages: pages,
  result: ocrResult(pages),
}));
const provider: OcrProvider = { policy, parse };
const user = () => {
  const id = uid();
  db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
    id,
    'Tester',
    `${id}@example.com`,
    0,
    0,
  );
  return id;
};
const grant = (pages = 500, owner = actor) =>
  grantOcrCredits(db, {
    id: uid(),
    actor: owner,
    kind: 'prepaid',
    pages,
    evidence: 'Manually verified payment receipt',
  });
function asset(pages = 1, owner = actor, label = uid()) {
  const bytes = pdfFixture(Array.from({ length: pages }, () => label)),
    id = uid();
  db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?,?)').run(
    id,
    owner,
    id,
    'application/pdf',
    bytes.length,
    Date.now(),
    createHash('sha256').update(bytes).digest('hex'),
  );
  objects.set(id, bytes);
  return id;
}
const service = (changes: Partial<OcrLimits> = {}, conn = db) =>
  new OcrService(conn, store, provider, { ...limits, ...changes });
async function submit(s: OcrService, id = asset(), owner = actor, key = uid()) {
  const q = await s.quote(owner, id);
  return s.submit(owner, id, key, q.policyId);
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mem-ocr-'));
  path = join(dir, 'db.sqlite');
  db = openDatabase(path);
  actor = user();
  objects.clear();
  parse.mockReset();
  parse.mockImplementation(async ({ pages }) => ({
    billedPages: pages,
    result: ocrResult(pages),
  }));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

it('fails closed without a provider or either operator budget, before spending', async () => {
  const id = asset();
  grant();
  for (const s of [
    new OcrService(db, store),
    service({ globalDailyLimitUsd: 0 }),
    service({ globalMonthlyLimitUsd: 0 }),
  ])
    await expect(s.quote(actor, id)).rejects.toThrow('not enabled');
  expect(db.prepare('SELECT * FROM spend_commitments').all()).toEqual([]);
  expect(parse).not.toHaveBeenCalled();
});
it('grants one invited trial and idempotent payment receipts, without public free credits', () => {
  expect(ocrCredits(db, actor).availablePages).toBe(0);
  const receipt = {
    id: uid(),
    actor,
    kind: 'trial' as const,
    pages: 50,
    evidence: 'Operator invitation reference',
  };
  grantOcrCredits(db, receipt);
  grantOcrCredits(db, receipt);
  expect(ocrCredits(db, actor).availablePages).toBe(50);
  expect(() => grantOcrCredits(db, { ...receipt, id: uid() })).toThrow('already received');
  expect(() => grantOcrCredits(db, { ...receipt, actor: user() })).toThrow('different grant');
  expect(() => grantOcrCredits(db, { ...receipt, id: uid(), pages: 500 })).toThrow('exactly 50');
  expect(() => db.prepare('DELETE FROM ocr_credit_grants').run()).toThrow('immutable');
});
it('checks real PDF pages and reserves credits before any provider call', async () => {
  const s = service(),
    id = asset(3),
    q = await s.quote(actor, id);
  expect(q.requiredCredits).toBe(3);
  await expect(s.submit(actor, id, uid(), q.policyId)).rejects.toThrow('requires page credits');
  grant(2);
  await expect(s.submit(actor, id, uid(), q.policyId)).rejects.toThrow('Not enough');
  expect(db.prepare('SELECT * FROM ocr_jobs').all()).toEqual([]);
  expect(parse).not.toHaveBeenCalled();
});
it('rejects oversized, corrupt and unauthorized documents before paid admission', async () => {
  grant();
  const id = asset(101),
    s = service();
  await expect(s.quote(actor, id)).rejects.toThrow('at most 100');
  const small = asset();
  await expect(service({ maxUploadBytes: 1 }).quote(actor, small)).rejects.toThrow('upload limit');
  await expect(s.quote(user(), small)).rejects.toThrow();
  objects.set(small, new Uint8Array([1]));
  await expect(s.quote(actor, small)).rejects.toThrow('integrity');
  expect(parse).not.toHaveBeenCalled();
});
it('deduplicates concurrent keys and service instances, and rejects reused keys with other bytes', async () => {
  grant();
  const id = asset(2),
    s = service(),
    q = await s.quote(actor, id),
    key = uid();
  const other = openDatabase(path);
  try {
    const results = await Promise.all([
      s.submit(actor, id, key, q.policyId),
      service({}, other).submit(actor, id, uid(), q.policyId),
      s.submit(actor, id, key, q.policyId),
    ]);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(ocrCredits(db, actor).committedPages).toBe(2);
    await expect(s.submit(actor, asset(), key, q.policyId)).rejects.toThrow('different content');
    await s.runNext();
    expect(parse).toHaveBeenCalledTimes(1);
    expect(await service({}, other).runNext()).toBe(false);
    expect((await s.quote(actor, id)).requiredCredits).toBe(0);
    expect((await s.submit(actor, id, uid(), q.policyId)).status).toBe('succeeded');
  } finally {
    other.close();
  }
});
it('serializes competing budget reservations across connections without overspending', async () => {
  grant();
  const a = asset(),
    b = asset(),
    s = service({ globalDailyLimitUsd: 0.004 }),
    q = await s.quote(actor, a),
    other = openDatabase(path);
  try {
    const results = await Promise.allSettled([
      s.submit(actor, a, uid(), q.policyId),
      service({ globalDailyLimitUsd: 0.004 }, other).submit(actor, b, uid(), q.policyId),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(committedSpend(db, new Date().toISOString().slice(0, 10))).toBe(4000);
    expect(ocrCredits(db, actor).committedPages).toBe(1);
  } finally {
    other.close();
  }
});
it('shares the operator budget with model runs while keeping category allowances distinct', async () => {
  grant();
  await submit(service({ globalDailyLimitUsd: 0.005 }));
  const modelPolicy = {
    dailyLimitUsd: 1,
    globalDailyLimitUsd: 0.005,
    globalMonthlyLimitUsd: 1,
    prices: {
      paid: {
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 2,
        vision: false,
        imageTokenBound: 0,
        source: 'https://example.com/pricing',
        verifiedAt: '2026-09-10',
      },
    },
  };
  expect(budgetState(db, actor, modelPolicy).availableMicrousd).toBe(1000);
  expect(budgetState(db, actor, modelPolicy).committedMicrousd).toBe(0);
  expect(() =>
    submitRun(
      db,
      revisions(db),
      actor,
      {
        braneId: createBrane(db, actor).id,
        key: uid(),
        model: 'paid',
        prompt: 'Hello',
        references: [],
        edits: [],
      },
      {
        models: ['paid'],
        maxTokens: 100,
        userConcurrency: 3,
        maxContextCharacters: 100000,
        costPolicy: modelPolicy,
      },
    ),
  ).toThrow('budget');
  await expect(submit(service({ categoryDailyLimitUsd: 0.004 }))).rejects.toThrow('budget');
});
it('enforces the calendar-month ceiling even when yesterday has rolled out of the daily window', async () => {
  grant();
  await submit(service());
  // A dispatched charge from earlier this month remains part of the monthly total.
  db.exec('DROP TRIGGER immutable_cost_estimate');
  db.prepare(
    "UPDATE spend_commitments SET budget_day=?,status='confirmed',confirmed_microusd=4000",
  ).run(new Date().toISOString().slice(0, 7) + '-01');
  await expect(submit(service({ globalMonthlyLimitUsd: 0.004 }))).rejects.toThrow('budget');
});
it('enforces daily pages and queued job limits independently of prepaid balance', async () => {
  grant();
  await submit(service({ userDailyPages: 2 }), asset(2));
  await expect(submit(service({ userDailyPages: 2 }))).rejects.toThrow('Daily PDF page limit');
  await expect(submit(service({ userQueuedJobs: 1 }))).rejects.toThrow('queue is full');
  const other = user();
  grant(500, other);
  await expect(submit(service({ globalQueuedJobs: 1 }), asset(1, other), other)).rejects.toThrow(
    'queue is full',
  );
});
it('settles extraction once and serves the persisted result without another charge', async () => {
  grant();
  const s = service(),
    job = await submit(s, asset(2));
  expect(ocrCredits(db, actor).availablePages).toBe(498);
  await s.runNext();
  expect(s.result(actor, job.id)).toEqual(ocrResult(2));
  expect(
    db.prepare('SELECT status,confirmed_microusd FROM spend_commitments WHERE id=?').get(job.id),
  ).toEqual({ status: 'confirmed', confirmed_microusd: 8000 });
  expect(() => s.read(user(), job.id)).toThrow('not found');
  expect(await s.runNext()).toBe(false);
});
it('limits dispatch to one active job per account and two globally', async () => {
  grant();
  const other = user();
  grant(500, other);
  const third = user();
  grant(500, third);
  const s = service();
  await submit(s);
  await submit(s);
  await submit(s, asset(1, other), other);
  await submit(s, asset(1, third), third);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  parse.mockImplementation(async ({ pages }) => {
    await gate;
    return { billedPages: pages, result: ocrResult(pages) };
  });
  const a = s.runNext(),
    b = s.runNext();
  await expect.poll(() => parse.mock.calls.length).toBe(2);
  expect(await s.runNext()).toBe(false);
  expect(
    new Set(
      (
        db.prepare("SELECT owner_id FROM ocr_jobs WHERE status='running'").all() as {
          owner_id: string;
        }[]
      ).map((r) => r.owner_id),
    ).size,
  ).toBe(2);
  release();
  await Promise.all([a, b]);
});
it('holds ambiguous timeout charges and credits, ignores late success, and never retries', async () => {
  grant();
  const s = service({ timeoutMs: 25 }),
    id = asset(),
    job = await submit(s, id);
  let finish!: (result: { billedPages: number; result: string }) => void;
  parse.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await s.runNext();
  expect(s.read(actor, job.id).status).toBe('uncertain');
  expect(ocrCredits(db, actor).committedPages).toBe(1);
  finish({ billedPages: 1, result: 'late' });
  await Promise.resolve();
  expect(s.result(actor, job.id)).toBeNull();
  expect(await s.runNext()).toBe(false);
  expect(parse).toHaveBeenCalledTimes(1);
  expect(committedSpend(db, '2099-01')).toBe(4000);
  expect((await submit(s, id)).id).toBe(job.id);
});
it('releases only known pre-dispatch failures and queued cancellation', async () => {
  grant();
  const s = service(),
    id = asset(),
    job = await submit(s, id);
  objects.delete(id);
  await s.runNext();
  expect(s.read(actor, job.id).status).toBe('failed');
  expect(ocrCredits(db, actor).committedPages).toBe(0);
  expect(parse).not.toHaveBeenCalled();
  const next = await submit(s);
  s.cancel(actor, next.id);
  expect(ocrCredits(db, actor).committedPages).toBe(0);
  expect(committedSpend(db, new Date().toISOString().slice(0, 10))).toBe(0);
});
it('survives reopening: queued jobs resume, dispatched jobs become uncertain and never replay', async () => {
  grant();
  const s = service(),
    dispatched = await submit(s),
    queued = await submit(s);
  db.prepare("UPDATE ocr_jobs SET status='running',attempt_id=?,deadline=1 WHERE id=?").run(
    uid(),
    dispatched.id,
  );
  db.close();
  db = openDatabase(path);
  const resumed = service();
  expect(resumed.recover()).toBe(1);
  expect(resumed.read(actor, dispatched.id).status).toBe('uncertain');
  await resumed.runNext();
  expect(resumed.read(actor, queued.id).status).toBe('succeeded');
  expect(parse).toHaveBeenCalledTimes(1);
  expect(ocrCredits(db, actor).committedPages).toBe(2);
});
it('reconciles uncertain billing and credits atomically with immutable evidence', async () => {
  grant();
  const s = service(),
    job = await submit(s);
  parse.mockRejectedValue(new Error('Network timeout'));
  await s.runNext();
  db.exec(
    "CREATE TRIGGER fail_ocr_audit BEFORE INSERT ON spend_reconciliations BEGIN SELECT RAISE(ABORT,'audit failed'); END",
  );
  expect(() => s.reconcile(job.id, 0, 'Provider confirms no charge')).toThrow('audit failed');
  expect(s.read(actor, job.id).status).toBe('uncertain');
  expect(ocrCredits(db, actor).committedPages).toBe(1);
  db.exec('DROP TRIGGER fail_ocr_audit');
  s.reconcile(job.id, 0, 'Provider confirms no charge');
  expect(ocrCredits(db, actor).committedPages).toBe(0);
  expect(() => s.reconcile(job.id, 0, 'Provider confirms no charge')).toThrow('Only uncertain');
  expect(() => db.prepare('DELETE FROM spend_reconciliations').run()).toThrow('immutable');
});
it('rejects stale policy acceptance and malformed or oversized provider output', async () => {
  grant();
  const s = service({ maxResultBytes: 1 }),
    id = asset(),
    q = await s.quote(actor, id);
  await expect(s.submit(actor, id, uid(), 'wrong-policy')).rejects.toThrow('policy changed');
  const job = await s.submit(actor, id, uid(), q.policyId);
  await s.runNext();
  expect(s.read(actor, job.id).status).toBe('uncertain');
  expect(ocrCredits(db, actor).committedPages).toBe(1);
});
it('keeps credit grants out of the public API and protects all OCR routes with authentication', async () => {
  let signedIn = false;
  const auth = {
    api: { getSession: async () => (signedIn ? { user: { id: actor } } : null) },
    handler: async () => new Response(),
  } as unknown as ReturnType<typeof createAuth>;
  const api = createApi(db, auth, new EventHub(), store, service());
  expect((await api.request('/ocr/credits')).status).toBe(401);
  signedIn = true;
  const credits = await api.request('/ocr/credits');
  expect(await credits.json()).toMatchObject({ availablePages: 0 });
  expect(
    (await api.request('/ocr/credits', { method: 'POST', body: JSON.stringify({ pages: 500 }) }))
      .status,
  ).toBe(404);
  const other = user(),
    id = asset(1, other);
  expect((await api.request(`/assets/${id}/ocr/quote`, { method: 'POST' })).status).toBe(404);
});

it('cannot oversubscribe the final page credit with concurrent admissions', async () => {
  grant(1);
  const s = service(),
    a = asset(),
    b = asset(),
    q = await s.quote(actor, a);
  const outcomes = await Promise.allSettled([
    s.submit(actor, a, uid(), q.policyId),
    s.submit(actor, b, uid(), q.policyId),
  ]);
  expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(ocrCredits(db, actor)).toMatchObject({ committedPages: 1, availablePages: 0 });
  expect(db.prepare('SELECT COUNT(*) n FROM spend_commitments').get()).toEqual({ n: 1 });
});
it('retains reservations while reduced operator ceilings prevent queued dispatch', async () => {
  grant();
  const first = service(),
    job = await submit(first, asset(2));
  const reduced = service({ globalDailyLimitUsd: 0.004 });
  expect(await reduced.runNext()).toBe(false);
  expect(reduced.read(actor, job.id).status).toBe('queued');
  expect(parse).not.toHaveBeenCalled();
  reduced.cancel(actor, job.id);
  expect(ocrCredits(db, actor).committedPages).toBe(0);
});
it('rolls back job admission if the durable receipt cannot be written', async () => {
  grant();
  const s = service(),
    id = asset(),
    q = await s.quote(actor, id);
  db.exec(
    "CREATE TRIGGER fail_receipt BEFORE INSERT ON ocr_requests BEGIN SELECT RAISE(ABORT,'receipt failed'); END",
  );
  await expect(s.submit(actor, id, uid(), q.policyId)).rejects.toThrow('receipt failed');
  expect(ocrCredits(db, actor).committedPages).toBe(0);
  expect(db.prepare('SELECT * FROM spend_commitments').all()).toEqual([]);
  expect(db.prepare('SELECT * FROM ocr_jobs').all()).toEqual([]);
});

it('applies verified pages to one owned block, preserving frozen context and replaying lost acknowledgements', async () => {
  grant();
  const s = service(),
    id = asset(2),
    brane = createBrane(db, actor);
  const metadata = db.prepare('SELECT digest FROM assets WHERE id=?').get(id) as { digest: string };
  const content = {
    format: 'pdf' as const,
    text: 'Original',
    filename: 'Research.pdf',
    assetId: id,
    assetHash: metadata.digest,
    mimeType: 'application/pdf' as const,
    pageCount: 2,
    representation: {
      kind: 'pdf-text-v1' as const,
      extractor: 'local',
      status: 'ready' as const,
      pages: [
        { number: 1, text: 'Original first page' },
        { number: 2, text: 'Original second page' },
      ],
    },
  };
  const selected = createBlock(db, actor, 'pdf', content, brane.id);
  const unchanged = createBlock(db, actor, 'pdf', content, brane.id);
  const frozen = revisions(db).snapshotBlock(actor, selected.id);
  const job = await submit(s, id);
  expect(() => s.apply(actor, job.id, selected.id, 0)).toThrow('not ready');
  await s.runNext();
  const disabled = new OcrService(db, store);
  expect(disabled.assetState(actor, id)).toMatchObject({
    enabled: false,
    job: { id: job.id, status: 'succeeded' },
  });
  expect(() => disabled.apply(user(), job.id, selected.id, 0)).toThrow('not found');
  expect(() => disabled.apply(actor, job.id, selected.id, 1)).toThrow('changed');
  expect(disabled.apply(actor, job.id, selected.id, 0)).toEqual({ version: 1 });
  expect(disabled.apply(actor, job.id, selected.id, 0)).toEqual({ version: 1 });
  const revised = revisions(db).snapshotBlock(actor, selected.id);
  expect(revised.id).not.toBe(frozen.id);
  expect(revised.content).toMatchObject({
    extractionPolicy: job.policyId,
    representation: {
      extractor: 'test/ocr-test',
      pages: [
        { number: 1, text: 'Verified extraction 1' },
        { number: 2, text: 'Verified extraction 2' },
      ],
    },
  });
  expect(readRevision(db, actor, frozen.id).content).toEqual(content);
  expect(revisions(db).snapshotBlock(actor, unchanged.id).content).toEqual(content);
  expect(
    readBrane(db, actor, brane.id).blocks.find((b) => b.id === selected.id)?.content,
  ).toMatchObject({ representation: { status: 'ready' } });
  expect(parse).toHaveBeenCalledTimes(1);
  expect(() => db.prepare("UPDATE ocr_jobs SET result_json='{}' WHERE id=?").run(job.id)).toThrow(
    'immutable',
  );
  expect(() => db.prepare("UPDATE ocr_jobs SET status='queued' WHERE id=?").run(job.id)).toThrow(
    'terminal',
  );
});

it('rejects wrong-document adoption and malformed normalized page identities', async () => {
  grant();
  const s = service(),
    id = asset(),
    job = await submit(s, id);
  const wrong = createBlock(db, actor, 'text', { format: 'text', text: 'Different document' });
  await s.runNext();
  expect(() => s.apply(actor, job.id, wrong.id, 0)).toThrow('different PDF');
  const bad = await submit(s);
  parse.mockResolvedValue({ billedPages: 1, result: ocrResult(2) });
  await s.runNext();
  expect(s.read(actor, bad.id).status).toBe('uncertain');
  expect(ocrCredits(db, actor).committedPages).toBe(2);
});

it('pauses worker claims at the storage gate, aborts dispatched work on shutdown and never replays', async () => {
  grant();
  const s = service(),
    job = await submit(s);
  let allowed = false;
  const fatal = vi.fn(),
    worker = new OcrWorker(s, () => allowed, fatal);
  worker.tick();
  expect(s.read(actor, job.id).status).toBe('queued');
  let signal: AbortSignal | undefined;
  parse.mockImplementation(async (request) => {
    signal = request.signal;
    return new Promise(() => {});
  });
  allowed = true;
  worker.tick();
  await expect.poll(() => parse.mock.calls.length).toBe(1);
  await worker.stop();
  expect(signal?.aborted).toBe(true);
  expect(s.read(actor, job.id).status).toBe('uncertain');
  expect(ocrCredits(db, actor).committedPages).toBe(1);
  expect(await s.runNext()).toBe(false);
  expect(fatal).not.toHaveBeenCalled();
});

it('shutdown while preparation ignores abort releases liabilities and fences late dispatch', async () => {
  grant();
  const id = asset(),
    initial = service(),
    job = await submit(initial, id);
  let release!: (bytes: Uint8Array) => void;
  const pendingStore = {
    ...store,
    get: vi.fn(
      () =>
        new Promise<Uint8Array>((resolve) => {
          release = resolve;
        }),
    ),
  };
  const s = new OcrService(db, pendingStore, provider, limits);
  const worker = new OcrWorker(s, () => true, vi.fn());
  worker.tick();
  await expect.poll(() => pendingStore.get.mock.calls.length).toBe(1);
  await worker.stop();
  expect(s.read(actor, job.id).status).toBe('failed');
  expect(ocrCredits(db, actor).committedPages).toBe(0);
  release(objects.get(id)!);
  await Promise.resolve();
  await Promise.resolve();
  expect(parse).not.toHaveBeenCalled();
});

it('a disabled executor recovers expired attempts only while maintenance writes are allowed', async () => {
  grant();
  const job = await submit(service());
  db.prepare("UPDATE ocr_jobs SET status='running',attempt_id=?,deadline=1 WHERE id=?").run(
    uid(),
    job.id,
  );
  const s = new OcrService(db, store),
    denied = new OcrWorker(s, () => false, vi.fn());
  denied.tick();
  expect(s.read(actor, job.id).status).toBe('running');
  const allowed = new OcrWorker(s, () => true, vi.fn());
  allowed.tick();
  expect(s.read(actor, job.id).status).toBe('uncertain');
  expect(parse).not.toHaveBeenCalled();
  await allowed.stop();
  await denied.stop();
});
