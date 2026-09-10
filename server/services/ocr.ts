import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DB } from '../db/index.js';
import { decodeRecord } from '../db/records.js';
import { DomainError, requireOwned } from '../domain/access.js';
import { money } from '../domain/money.js';
import { inspectPdf } from '../ingestion/pdf.js';
import { policyIdentity } from '../ingestion/policy.js';
import type { AssetStore } from '../storage/assets.js';
import { reconcileSpend, reserveSpend, spendHeadroom, type CategoryLimits } from './spend.js';

const safeInt = z.number().int().nonnegative();
export const ocrPolicySchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    version: z.string().min(1),
    microusdPerPage: safeInt.positive(),
    priceSource: z.url(),
    verifiedAt: z.iso.date(),
    options: z.record(z.string(), z.unknown()),
  })
  .strict();
export type OcrPolicy = z.infer<typeof ocrPolicySchema>;
export interface OcrLimits extends CategoryLimits {
  maxUploadBytes: number;
  maxDocumentPages: number;
  userDailyPages: number;
  userQueuedJobs: number;
  globalQueuedJobs: number;
  globalConcurrency: number;
  timeoutMs: number;
  maxResultBytes: number;
}
export const defaultOcrLimits: OcrLimits = {
  globalDailyLimitUsd: 0,
  globalMonthlyLimitUsd: 0,
  categoryDailyLimitUsd: 10,
  categoryMonthlyLimitUsd: 100,
  maxUploadBytes: 5 * 1024 * 1024,
  maxDocumentPages: 100,
  userDailyPages: 500,
  userQueuedJobs: 3,
  globalQueuedJobs: 6,
  globalConcurrency: 2,
  timeoutMs: 60_000,
  maxResultBytes: 10 * 1024 * 1024,
};
const jobSchema = z
  .object({
    id: z.string(),
    owner_id: z.string(),
    asset_id: z.string(),
    asset_digest: z.string(),
    policy_id: z.string(),
    policy_json: z.string(),
    pages: safeInt.positive(),
    credit_pages: safeInt,
    status: z.enum(['queued', 'running', 'succeeded', 'uncertain', 'cancelled', 'failed']),
    attempt_id: z.string().nullable(),
    deadline: safeInt.nullable(),
    result_json: z.string().nullable(),
    error: z.string().nullable(),
    created_at: safeInt,
    updated_at: safeInt,
  })
  .strict();
type OcrJob = z.infer<typeof jobSchema>;
export interface OcrProvider {
  policy: OcrPolicy;
  // Implementations must disable transport retries. Every thrown/invalid response is uncertain.
  parse(request: {
    bytes: Uint8Array;
    pages: number;
    policy: OcrPolicy;
    jobId: string;
    signal: AbortSignal;
  }): Promise<{ billedPages: number; result: unknown }>;
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function pageCost(pages: number, rate: number) {
  return money(BigInt(safeInt.parse(pages)) * BigInt(safeInt.parse(rate)));
}
export function ocrCredits(db: DB, actor: string) {
  const read = (sql: string) =>
    money(
      decodeRecord(
        z.object({ n: z.bigint().nonnegative() }),
        db.prepare(sql).safeIntegers().get(actor),
      ).n,
    );
  const granted = read('SELECT COALESCE(SUM(pages),0) n FROM ocr_credit_grants WHERE owner_id=?');
  const committed = read('SELECT COALESCE(SUM(credit_pages),0) n FROM ocr_jobs WHERE owner_id=?');
  return {
    grantedPages: granted,
    committedPages: committed,
    availablePages: Math.max(0, granted - committed),
  };
}
// Operator-only entry point. A prepaid receipt is recorded only after payment verification.
// Receipt IDs are globally unique, so retries and cross-account replay cannot mint credits.
export function grantOcrCredits(
  db: DB,
  input: { id: string; actor: string; kind: 'trial' | 'prepaid'; pages: number; evidence: string },
) {
  z.object({
    id: z.string().min(1).max(200),
    actor: z.string().min(1),
    kind: z.enum(['trial', 'prepaid']),
    pages: safeInt.positive().max(100000),
    evidence: z.string().trim().min(8).max(2000),
  })
    .strict()
    .parse(input);
  if (input.kind === 'trial' && input.pages !== 50)
    throw new DomainError(400, 'An invited trial grants exactly 50 pages once');
  return db
    .transaction(() => {
      const existing = db
        .prepare('SELECT owner_id,kind,pages,evidence FROM ocr_credit_grants WHERE id=?')
        .get(input.id);
      if (existing) {
        if (
          JSON.stringify(existing) !==
          JSON.stringify({
            owner_id: input.actor,
            kind: input.kind,
            pages: input.pages,
            evidence: input.evidence,
          })
        )
          throw new DomainError(409, 'Credit receipt belongs to a different grant');
        return ocrCredits(db, input.actor);
      }
      if (
        input.kind === 'trial' &&
        db
          .prepare("SELECT 1 FROM ocr_credit_grants WHERE owner_id=? AND kind='trial'")
          .get(input.actor)
      )
        throw new DomainError(409, 'This account has already received its trial');
      db.prepare('INSERT INTO ocr_credit_grants VALUES (?,?,?,?,?,?)').run(
        input.id,
        input.actor,
        input.kind,
        input.pages,
        input.evidence,
        Date.now(),
      );
      return ocrCredits(db, input.actor);
    })
    .immediate();
}

export class OcrService {
  readonly limits: OcrLimits;
  private readonly policy?: OcrPolicy;
  private readonly identity?: ReturnType<typeof policyIdentity>;
  constructor(
    private db: DB,
    private store: AssetStore,
    private provider?: OcrProvider,
    limits: OcrLimits = defaultOcrLimits,
  ) {
    for (const key of [
      'maxUploadBytes',
      'maxDocumentPages',
      'userDailyPages',
      'userQueuedJobs',
      'globalQueuedJobs',
      'globalConcurrency',
      'timeoutMs',
      'maxResultBytes',
    ] as const)
      safeInt.positive().parse(limits[key]);
    if (limits.maxDocumentPages > 100)
      throw new Error('OCR document limit cannot exceed 100 pages');
    for (const key of [
      'globalDailyLimitUsd',
      'globalMonthlyLimitUsd',
      'categoryDailyLimitUsd',
      'categoryMonthlyLimitUsd',
    ] as const)
      z.number().nonnegative().parse(limits[key]);
    this.limits = Object.freeze({ ...limits });
    if (provider) {
      this.identity = policyIdentity(ocrPolicySchema.parse(provider.policy));
      this.policy = ocrPolicySchema.parse(JSON.parse(this.identity.json));
    }
  }
  get enabled() {
    return (
      !!this.provider &&
      !!this.limits.globalDailyLimitUsd &&
      !!this.limits.globalMonthlyLimitUsd &&
      !!this.limits.categoryDailyLimitUsd &&
      !!this.limits.categoryMonthlyLimitUsd
    );
  }
  private requireEnabled() {
    if (!this.enabled) throw new DomainError(503, 'Enhanced PDF parsing is not enabled');
  }
  private job(id: string): OcrJob {
    const row = this.db.prepare('SELECT * FROM ocr_jobs WHERE id=?').get(id);
    if (!row) throw new DomainError(404, 'OCR job not found');
    return decodeRecord(jobSchema, row);
  }
  read(actor: string, id: string) {
    const job = this.job(id);
    if (job.owner_id !== actor) throw new DomainError(404, 'OCR job not found');
    return {
      id: job.id,
      status: job.status,
      pages: job.pages,
      committedPages: job.credit_pages,
      error: job.error,
    };
  }
  result(actor: string, id: string) {
    this.read(actor, id);
    const job = this.job(id);
    return job.result_json === null ? null : (JSON.parse(job.result_json) as unknown);
  }
  private asset(actor: string, assetId: string) {
    const asset = requireOwned(this.db, 'assets', actor, assetId);
    if (asset.mime !== 'application/pdf') throw new DomainError(400, 'Choose a PDF');
    if (asset.size > this.limits.maxUploadBytes)
      throw new DomainError(400, 'PDF exceeds the upload limit');
    return asset;
  }
  private async inspect(actor: string, assetId: string) {
    const asset = this.asset(actor, assetId);
    const bytes = await this.store.get(assetId, AbortSignal.timeout(15000));
    if (bytes.byteLength !== asset.size || hash(bytes) !== asset.digest)
      throw new DomainError(409, 'PDF bytes failed integrity verification');
    const { pageCount: pages } = await inspectPdf(bytes);
    if (pages > this.limits.maxDocumentPages)
      throw new DomainError(400, `Choose a PDF with at most ${this.limits.maxDocumentPages} pages`);
    return { asset, pages };
  }
  private existing(actor: string, digest: string) {
    return this.db
      .prepare('SELECT id FROM ocr_jobs WHERE owner_id=? AND asset_digest=? AND policy_id=?')
      .get(actor, digest, this.identity!.id) as { id: string } | undefined;
  }
  async quote(actor: string, assetId: string) {
    this.requireEnabled();
    const asset = this.asset(actor, assetId),
      cached = this.existing(actor, asset.digest);
    if (cached)
      return {
        policyId: this.identity!.id,
        pages: this.job(cached.id).pages,
        requiredCredits: 0,
        job: this.read(actor, cached.id),
        credits: ocrCredits(this.db, actor),
      };
    const { pages } = await this.inspect(actor, assetId);
    return {
      policyId: this.identity!.id,
      pages,
      requiredCredits: pages,
      job: null,
      credits: ocrCredits(this.db, actor),
    };
  }
  async submit(actor: string, assetId: string, key: string, acceptedPolicyId: string) {
    this.requireEnabled();
    z.string().min(1).max(200).parse(key);
    if (acceptedPolicyId !== this.identity!.id)
      throw new DomainError(409, 'Parsing policy changed; request a new quote');
    const asset = this.asset(actor, assetId);
    const receipt = this.db
      .prepare(
        'SELECT asset_digest,policy_id,job_id FROM ocr_requests WHERE owner_id=? AND request_key=?',
      )
      .get(actor, key) as { asset_digest: string; policy_id: string; job_id: string } | undefined;
    if (receipt) {
      if (receipt.asset_digest !== asset.digest || receipt.policy_id !== acceptedPolicyId)
        throw new DomainError(409, 'OCR request key belongs to different content');
      return this.read(actor, receipt.job_id);
    }
    const cached = this.existing(actor, asset.digest);
    if (!cached && !ocrCredits(this.db, actor).availablePages)
      throw new DomainError(402, 'Enhanced parsing requires page credits');
    const pages = cached ? this.job(cached.id).pages : (await this.inspect(actor, assetId)).pages;
    return this.db
      .transaction(() => {
        // Repeat all admission checks under the write lock after asynchronous local inspection.
        this.asset(actor, assetId);
        const known = this.existing(actor, asset.digest);
        let id = known?.id;
        if (!id) {
          if (ocrCredits(this.db, actor).availablePages < pages)
            throw new DomainError(402, 'Not enough PDF page credits');
          const day = new Date().toISOString().slice(0, 10);
          const used = decodeRecord(
            z.object({ n: z.bigint().nonnegative() }),
            this.db
              .prepare(
                `SELECT COALESCE(SUM(j.credit_pages),0) n FROM ocr_jobs j JOIN spend_commitments s ON s.id=j.id
          WHERE j.owner_id=? AND (s.budget_day=? OR s.status IN ('reserved','uncertain'))`,
              )
              .safeIntegers()
              .get(actor, day),
          ).n;
          if (used + BigInt(pages) > BigInt(this.limits.userDailyPages))
            throw new DomainError(429, 'Daily PDF page limit reached');
          const count = this.db
            .prepare(
              `SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN owner_id=? THEN 1 ELSE 0 END),0) actor FROM ocr_jobs WHERE status='queued'`,
            )
            .get(actor) as { total: number; actor: number };
          if (
            count.total >= this.limits.globalQueuedJobs ||
            count.actor >= this.limits.userQueuedJobs
          )
            throw new DomainError(429, 'PDF parsing queue is full');
          id = randomUUID();
          reserveSpend(
            this.db,
            {
              id,
              actor,
              category: 'ocr',
              amount: pageCost(pages, this.policy!.microusdPerPage),
              units: pages,
              pricing: this.policy,
            },
            this.limits,
          );
          this.db
            .prepare(
              `INSERT INTO ocr_jobs (id,owner_id,asset_id,asset_digest,policy_id,policy_json,pages,credit_pages,status,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,'queued',?,?)`,
            )
            .run(
              id,
              actor,
              assetId,
              asset.digest,
              this.identity!.id,
              this.identity!.json,
              pages,
              pages,
              Date.now(),
              Date.now(),
            );
        }
        const old = this.db
          .prepare('SELECT job_id FROM ocr_requests WHERE owner_id=? AND request_key=?')
          .get(actor, key) as { job_id: string } | undefined;
        if (old && old.job_id !== id)
          throw new DomainError(409, 'OCR request key belongs to different content');
        this.db
          .prepare(
            'INSERT INTO ocr_requests VALUES (?,?,?,?,?) ON CONFLICT(owner_id,request_key) DO NOTHING',
          )
          .run(actor, key, asset.digest, this.identity!.id, id);
        return this.read(actor, id);
      })
      .immediate();
  }
  cancel(actor: string, id: string) {
    return this.db
      .transaction(() => {
        this.read(actor, id);
        const changed = this.db
          .prepare(
            "UPDATE ocr_jobs SET status='cancelled',credit_pages=0,updated_at=? WHERE id=? AND status='queued'",
          )
          .run(Date.now(), id);
        if (!changed.changes) throw new DomainError(409, 'Only queued parsing can be cancelled');
        this.db
          .prepare(
            "UPDATE spend_commitments SET status='released',updated_at=? WHERE id=? AND status='reserved'",
          )
          .run(Date.now(), id);
      })
      .immediate();
  }
  recover(time = Date.now()) {
    return this.db
      .transaction(() => {
        const expired = this.db
          .prepare("SELECT id FROM ocr_jobs WHERE status='running' AND deadline<=?")
          .all(time) as { id: string }[];
        for (const { id } of expired) {
          this.db
            .prepare(
              "UPDATE ocr_jobs SET status='uncertain',error='Parsing completion or billing is uncertain',updated_at=? WHERE id=?",
            )
            .run(time, id);
          this.db
            .prepare(
              "UPDATE spend_commitments SET status='uncertain',updated_at=? WHERE id=? AND status='reserved'",
            )
            .run(time, id);
        }
        return expired.length;
      })
      .immediate();
  }
  reconcile(id: string, billedPages: number, evidence: string) {
    return this.db
      .transaction(() => {
        const job = this.job(id);
        if (job.status !== 'uncertain')
          throw new DomainError(409, 'Only uncertain OCR jobs can be reconciled');
        const pages = safeInt.max(job.pages).parse(billedPages);
        const policy = ocrPolicySchema.parse(JSON.parse(job.policy_json));
        reconcileSpend(this.db, id, pageCost(pages, policy.microusdPerPage), evidence);
        this.db
          .prepare(
            "UPDATE ocr_jobs SET status='failed',credit_pages=?,error='Billing reconciled; no verified extraction result',updated_at=? WHERE id=?",
          )
          .run(pages, Date.now(), id);
      })
      .immediate();
  }
  // One claim/attempt per job. Queued work survives restart; dispatched work never auto-replays.
  async runNext(): Promise<boolean> {
    this.requireEnabled();
    this.recover();
    const claimed = this.db
      .transaction(() => {
        const active = this.db
          .prepare("SELECT COUNT(*) n FROM ocr_jobs WHERE status='running'")
          .get() as { n: number };
        if (active.n >= this.limits.globalConcurrency) return;
        const row = this.db
          .prepare(
            `SELECT j.* FROM ocr_jobs j WHERE j.status='queued' AND j.policy_id=?
        AND NOT EXISTS(SELECT 1 FROM ocr_jobs a WHERE a.owner_id=j.owner_id AND a.status='running') ORDER BY j.created_at,j.id LIMIT 1`,
          )
          .get(this.identity!.id);
        if (!row) return;
        const job = decodeRecord(jobSchema, row),
          attempt = randomUUID();
        // Recheck the operator kill switch/budgets after policy changes. This job's reservation is already counted.
        if (spendHeadroom(this.db, job.owner_id, 'ocr', this.limits) < 0) return;
        this.db
          .prepare(
            "UPDATE ocr_jobs SET status='running',attempt_id=?,deadline=?,updated_at=? WHERE id=?",
          )
          .run(attempt, Date.now() + this.limits.timeoutMs, Date.now(), job.id);
        return { ...job, attempt_id: attempt };
      })
      .immediate();
    if (!claimed) return false;
    let dispatched = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('OCR deadline exceeded'));
      }, this.limits.timeoutMs);
    });
    try {
      const work = async () => {
        const asset = this.asset(claimed.owner_id, claimed.asset_id);
        const bytes = await this.store.get(claimed.asset_id, controller.signal);
        if (bytes.byteLength !== asset.size || hash(bytes) !== claimed.asset_digest)
          throw new Error('PDF bytes failed integrity verification');
        controller.signal.throwIfAborted();
        dispatched = true;
        return this.provider!.parse({
          bytes,
          pages: claimed.pages,
          policy: ocrPolicySchema.parse(JSON.parse(claimed.policy_json)),
          jobId: claimed.id,
          signal: controller.signal,
        });
      };
      const response = await Promise.race([work(), deadline]);
      const billedPages = safeInt.max(claimed.pages).parse(response.billedPages);
      const json = JSON.stringify(response.result);
      if (!json || Buffer.byteLength(json) > this.limits.maxResultBytes)
        throw new Error('Invalid or oversized OCR result');
      this.db
        .transaction(() => {
          const changed = this.db
            .prepare(
              "UPDATE ocr_jobs SET status='succeeded',result_json=?,credit_pages=?,updated_at=? WHERE id=? AND status='running' AND attempt_id=? AND deadline>?",
            )
            .run(json, billedPages, Date.now(), claimed.id, claimed.attempt_id, Date.now());
          if (!changed.changes) return;
          this.db
            .prepare(
              "UPDATE spend_commitments SET status='confirmed',confirmed_microusd=?,updated_at=? WHERE id=? AND status='reserved'",
            )
            .run(pageCost(billedPages, this.policy!.microusdPerPage), Date.now(), claimed.id);
        })
        .immediate();
    } catch {
      this.db
        .transaction(() => {
          const status = dispatched ? 'uncertain' : 'failed';
          const changed = this.db
            .prepare(
              "UPDATE ocr_jobs SET status=?,credit_pages=?,error=?,updated_at=? WHERE id=? AND status='running' AND attempt_id=?",
            )
            .run(
              status,
              dispatched ? claimed.pages : 0,
              dispatched
                ? 'Parsing completion or billing is uncertain'
                : 'PDF preparation failed; no provider call was made',
              Date.now(),
              claimed.id,
              claimed.attempt_id,
            );
          if (!changed.changes) return;
          this.db
            .prepare(
              "UPDATE spend_commitments SET status=?,updated_at=? WHERE id=? AND status='reserved'",
            )
            .run(dispatched ? 'uncertain' : 'released', Date.now(), claimed.id);
        })
        .immediate();
    } finally {
      clearTimeout(timer);
      controller.abort();
      this.recover();
    }
    return true;
  }
}
