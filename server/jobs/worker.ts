import { fitsArtifactContent } from '../../shared/limits.js';
import { abortable } from '../app/abort.js';
import {
  settleCost,
  holdUncertainCost,
  releaseUninvokedCost,
  releaseFailedPreflightCost,
} from '../services/costs.js';
import { BeforeInvocationError } from '../llm/errors.js';
import { lifecycleLog } from '../app/logging.js';
import type { DB } from '../db/index.js';
import { now, uid } from '../services/content.js';
import { readInputs } from '../services/runs.js';
import type { ModelExecutor } from '../llm/model.js';
import type { EventHub } from '../sse/hub.js';
export interface WorkerOptions {
  concurrency: number;
  leaseMs: number;
  checkpointMs: number;
  checkpointCharacters: number;
  totalMs?: number;
  idleMs?: number;
  canClaim?: () => boolean;
  onFatal?: (error: unknown) => void;
}
export function recoverStale(db: DB, time = now()) {
  return db.transaction(() => {
    const stale = db
      .prepare(
        "SELECT id,status FROM runs WHERE lease_until<? AND status IN ('running','cancel_requested')",
      )
      .all(time) as { id: string; status: string }[];
    for (const run of stale) {
      if (db.prepare('SELECT 1 FROM run_attempts WHERE run_id=?').get(run.id))
        holdUncertainCost(db, run.id);
      else releaseUninvokedCost(db, run.id);
      lifecycleLog('lease_expired', { runId: run.id, status: run.status });
    }
    db.prepare(
      "UPDATE run_attempts SET finished_at=?,outcome='interrupted' WHERE finished_at IS NULL AND run_id IN (SELECT id FROM runs WHERE lease_until<? AND status IN ('running','cancel_requested'))",
    ).run(time, time);
    db.prepare(
      "UPDATE runs SET status='queued',lease_owner=NULL,lease_until=NULL WHERE status='claimed' AND lease_until<?",
    ).run(time);
    db.prepare(
      "UPDATE runs SET status=CASE WHEN status='cancel_requested' THEN 'cancelled' ELSE 'interrupted' END,error='Worker lease expired; provider completion is uncertain',finished_at=?,lease_owner=NULL,lease_until=NULL WHERE status IN ('running','cancel_requested') AND lease_until<?",
    ).run(time, time);
  })();
}
export function claimRun(db: DB, workerId: string, leaseMs: number) {
  return db
    .transaction(() => {
      const run = db
        .prepare("SELECT * FROM runs WHERE status='queued' ORDER BY created_at LIMIT 1")
        .get() as any;
      if (!run) return null;
      const claimed = db
        .prepare(
          "UPDATE runs SET status='claimed',lease_owner=?,lease_until=? WHERE id=? AND status='queued'",
        )
        .run(workerId, now() + leaseMs, run.id);
      return claimed.changes ? { ...run, status: 'claimed', lease_owner: workerId } : null;
    })
    .immediate();
}
export class RunWorker {
  readonly id = uid();
  private active = new Map<string, AbortController>();
  private promises = new Set<Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private stopping = false;
  private failed = false;
  get healthy() {
    return !this.failed && !this.stopping;
  }
  private fail(error: unknown) {
    if (this.failed) return;
    this.failed = true;
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    for (const controller of this.active.values()) controller.abort(error);
    lifecycleLog('worker_failed', { workerId: this.id });
    this.options.onFatal?.(error);
  }
  constructor(
    private db: DB,
    private hub: EventHub,
    private execute: ModelExecutor,
    private options: WorkerOptions,
  ) {}
  start() {
    this.tick();
    if (!this.stopping) this.timer = setInterval(() => this.tick(), 250);
  }
  tick() {
    if (this.stopping) return;
    try {
      recoverStale(this.db);
      while (this.active.size < this.options.concurrency && (this.options.canClaim?.() ?? true)) {
        const run = claimRun(this.db, this.id, this.options.leaseMs);
        if (!run) break;
        const controller = new AbortController();
        this.active.set(run.id, controller);
        const promise = this.perform(run, controller)
          .catch((error) => this.fail(error))
          .finally(() => {
            this.active.delete(run.id);
            this.promises.delete(promise);
          });
        this.promises.add(promise);
      }
    } catch (error) {
      this.fail(error);
    }
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    for (const c of this.active.values()) c.abort(new Error('Server shutdown'));
    await Promise.allSettled(this.promises);
  }
  private async perform(run: any, controller: AbortController) {
    const db = this.db;
    let text = '',
      savedText = '',
      savedAt = now();
    const attemptId = uid();
    const publish = (status?: string) => {
      if (status) lifecycleLog('run_status', { runId: run.id, status, workerId: this.id });
      this.hub.publish(run.owner_id, {
        type: 'run',
        runId: run.id,
        braneId: run.brane_id,
        status,
        text,
      });
    };
    const checkpoint = () => {
      db.prepare(
        'INSERT INTO run_checkpoints VALUES (?,?,?) ON CONFLICT(run_id) DO UPDATE SET text=excluded.text,updated_at=excluded.updated_at',
      ).run(run.id, text, now());
      savedText = text;
      savedAt = now();
    };
    const started = db.transaction(() => {
      const result = db
        .prepare(
          "UPDATE runs SET status='running',started_at=? WHERE id=? AND status='claimed' AND lease_owner=?",
        )
        .run(now(), run.id, this.id);
      if (!result.changes) {
        db.prepare(
          "UPDATE runs SET status='cancelled',finished_at=? WHERE id=? AND status='cancel_requested'",
        ).run(now(), run.id);
        return false;
      }
      db.prepare(
        'INSERT INTO run_attempts (id,run_id,worker_id,started_at,heartbeat_at) VALUES (?,?,?,?,?)',
      ).run(attemptId, run.id, this.id, now(), now());
      return true;
    })();
    if (!started) {
      releaseUninvokedCost(db, run.id);
      publish('cancelled');
      return;
    }
    publish('running');
    const heartbeat = setInterval(
      () => {
        try {
          const current = db
            .prepare('SELECT status,lease_owner FROM runs WHERE id=?')
            .get(run.id) as any;
          if (
            current.status === 'cancel_requested' ||
            current.lease_owner !== this.id ||
            current.status !== 'running'
          )
            controller.abort(new Error('Run stopped'));
          else {
            db.prepare('UPDATE runs SET lease_until=? WHERE id=? AND lease_owner=?').run(
              now() + this.options.leaseMs,
              run.id,
              this.id,
            );
            db.prepare('UPDATE run_attempts SET heartbeat_at=? WHERE id=?').run(now(), attemptId);
          }
          if (text !== savedText && now() - savedAt >= this.options.checkpointMs) checkpoint();
        } catch (error) {
          this.fail(error);
        }
      },
      Math.min(500, Math.max(50, this.options.leaseMs / 3)),
    );
    const total = setTimeout(
      () => controller.abort(new Error('Run deadline exceeded')),
      this.options.totalMs ?? 300000,
    );
    let idle: ReturnType<typeof setTimeout>;
    const progress = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () => controller.abort(new Error('Run stalled')),
        this.options.idleMs ?? 60000,
      );
    };
    progress();
    try {
      const result = await abortable(
        this.execute(
          {
            actor: run.owner_id,
            model: run.model,
            maxOutputTokens: JSON.parse(run.options_json).maxOutputTokens,
            inputs: readInputs(db, run.id),
            signal: controller.signal,
          },
          (chunk) => {
            controller.signal.throwIfAborted();
            progress();
            if (!fitsArtifactContent({ text: text + chunk }))
              throw new Error('Generated text exceeds the character limit');
            text += chunk;
            publish();
            if (
              text.length - savedText.length >= this.options.checkpointCharacters ||
              now() - savedAt >= this.options.checkpointMs
            )
              checkpoint();
          },
        ),
        controller.signal,
      );
      controller.signal.throwIfAborted();
      if (!fitsArtifactContent({ text: result.text }))
        throw new Error('Generated text exceeds the character limit');
      db.transaction(() => {
        const current = db
          .prepare('SELECT status,lease_owner FROM runs WHERE id=?')
          .get(run.id) as any;
        if (current.status !== 'running' || current.lease_owner !== this.id)
          throw new Error('Run no longer owned');
        text = result.text;
        checkpoint();
        const revisionId = uid(),
          userMessage = uid(),
          assistantMessage = uid();
        db.prepare(
          'INSERT INTO block_revisions (id,block_id,content_json,created_at) VALUES (?,?,?,?)',
        ).run(revisionId, run.output_block_id, JSON.stringify({ format: 'text', text }), now());
        const inputs = readInputs(db, run.id);
        const prompt = inputs.find((i) => i.kind === 'prompt')!;
        db.prepare(
          'INSERT INTO conversation_messages (id,conversation_id,parent_id,role,revision_id,created_at,context_json) VALUES (?,?,?,?,?,?,?)',
        ).run(
          userMessage,
          run.conversation_id,
          run.continue_from,
          'user',
          prompt.revision_id,
          now(),
          JSON.stringify(
            inputs
              .filter((i) => i.kind === 'source' || i.kind === 'reference')
              .map((i) => ({ revisionId: i.revision_id, label: i.label })),
          ),
        );
        db.prepare(
          'INSERT INTO conversation_messages (id,conversation_id,parent_id,role,revision_id,created_at) VALUES (?,?,?,?,?,?)',
        ).run(assistantMessage, run.conversation_id, userMessage, 'assistant', revisionId, now());
        db.prepare('INSERT INTO run_outputs VALUES (?,?,?)').run(
          run.id,
          revisionId,
          assistantMessage,
        );
        db.prepare(
          "UPDATE runs SET status='completed',usage_json=?,finished_at=?,lease_owner=NULL,lease_until=NULL WHERE id=?",
        ).run(result.usage ? JSON.stringify(result.usage) : null, now(), run.id);
        db.prepare("UPDATE run_attempts SET finished_at=?,outcome='completed' WHERE id=?").run(
          now(),
          attemptId,
        );
        settleCost(db, run.id, result.usage, run.model === 'mock');
      })();
      publish('completed');
    } catch (error) {
      const current = db
        .prepare('SELECT status,lease_owner FROM runs WHERE id=?')
        .get(run.id) as any;
      if (current.lease_owner === this.id) {
        const status =
          current.status === 'cancel_requested'
            ? 'cancelled'
            : this.stopping
              ? 'interrupted'
              : 'failed';
        db.transaction(() => {
          checkpoint();
          if (error instanceof BeforeInvocationError) releaseFailedPreflightCost(db, run.id);
          else holdUncertainCost(db, run.id);
          db.prepare(
            'UPDATE runs SET status=?,error=?,finished_at=?,lease_owner=NULL,lease_until=NULL WHERE id=?',
          ).run(
            status,
            status === 'failed'
              ? error instanceof BeforeInvocationError
                ? 'Model preparation failed; no provider call was made'
                : 'Model request failed; completion or billing may be uncertain'
              : status === 'interrupted'
                ? 'Server stopped; provider completion is uncertain'
                : null,
            now(),
            run.id,
          );
          db.prepare('UPDATE run_attempts SET finished_at=?,outcome=? WHERE id=?').run(
            now(),
            status,
            attemptId,
          );
        })();
        publish(status);
      }
      if (!controller.signal.aborted)
        console.error(
          'Run execution failed',
          run.id,
          error instanceof Error ? error.name : 'Unknown error',
        );
    } finally {
      clearInterval(heartbeat);
      clearTimeout(total);
      clearTimeout(idle!);
    }
  }
}
