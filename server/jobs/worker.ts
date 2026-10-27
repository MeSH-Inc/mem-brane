import { decodeJson, runOptions, type RunRecord } from '../db/records.js';
import { fitsArtifactContent } from '../../shared/limits.js';
import { abortable } from '../app/abort.js';
import {
  claimRun,
  recoverStale,
  startAttempt,
  renewAttempt,
  saveCheckpoint,
  completeAttempt,
  stopAttempt,
} from '../services/run-lifecycle.js';
import { BeforeInvocationError } from '../llm/errors.js';
import { lifecycleLog } from '../app/logging.js';
import type { DB } from '../db/index.js';
import { now, uid } from '../services/content.js';
import { readInputs } from '../services/context-reader.js';
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
// Each bound on a run has its own cause, so the stored reason never depends on message text.
class RunStalled extends Error {
  constructor() {
    super('Run stalled');
  }
}
class RunDeadlineExceeded extends Error {
  constructor() {
    super('Run deadline exceeded');
  }
}
class RunOutputLimitExceeded extends Error {
  constructor() {
    super('Generated text exceeds the character limit');
  }
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
      this.recover();
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
  private recover() {
    for (const run of recoverStale(this.db)) {
      lifecycleLog('lease_expired', { runId: run.id, status: run.status });
      this.hub.publish(run.owner_id, {
        type: 'run',
        runId: run.id,
        braneId: run.brane_id,
        status: run.status,
      });
    }
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    for (const c of this.active.values()) c.abort(new Error('Server shutdown'));
    await Promise.allSettled(this.promises);
  }
  private async perform(run: RunRecord, controller: AbortController) {
    const db = this.db;
    let text = '',
      savedText = '',
      savedAt = now();
    const token = startAttempt(db, run.id, this.id);
    if (!token) return;
    const started = now();
    const publish = (status?: RunRecord['status']) => {
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
      if (!saveCheckpoint(db, token, text)) throw new Error('Run no longer owned');
      savedText = text;
      savedAt = now();
    };
    publish('running');
    const heartbeat = setInterval(
      () => {
        try {
          if (!renewAttempt(db, token, this.options.leaseMs)) {
            controller.abort(new Error('Run stopped'));
            return;
          }
          if (text !== savedText && now() - savedAt >= this.options.checkpointMs) checkpoint();
        } catch (error) {
          this.fail(error);
        }
      },
      Math.min(500, Math.max(50, this.options.leaseMs / 3)),
    );
    const total = setTimeout(
      () => controller.abort(new RunDeadlineExceeded()),
      this.options.totalMs ?? 300000,
    );
    let idle: ReturnType<typeof setTimeout>;
    const progress = () => {
      clearTimeout(idle);
      idle = setTimeout(() => controller.abort(new RunStalled()), this.options.idleMs ?? 60000);
    };
    progress();
    try {
      const result = await abortable(
        this.execute(
          {
            actor: run.owner_id,
            model: run.model,
            maxOutputTokens: decodeJson(runOptions, run.options_json).maxOutputTokens,
            inputs: readInputs(db, run.id),
            signal: controller.signal,
          },
          (chunk) => {
            controller.signal.throwIfAborted();
            progress();
            if (!fitsArtifactContent({ text: text + chunk })) throw new RunOutputLimitExceeded();
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
      if (!fitsArtifactContent({ text: result.text })) throw new RunOutputLimitExceeded();
      if (!completeAttempt(db, token, result)) throw new Error('Run no longer owned');
      text = result.text;
      publish('completed');
    } catch (error) {
      const cause = controller.signal.aborted ? controller.signal.reason : error;
      const reason =
        cause instanceof BeforeInvocationError
          ? 'preflight'
          : this.stopping
            ? 'shutdown'
            : cause instanceof RunStalled
              ? 'stalled'
              : cause instanceof RunDeadlineExceeded
                ? 'deadline'
                : cause instanceof RunOutputLimitExceeded
                  ? 'output_limit'
                  : 'provider';
      const status = stopAttempt(db, token, text, reason);
      if (status) publish(status);
      else this.recover();
      lifecycleLog('run_stopped', {
        runId: run.id,
        workerId: this.id,
        status: status ?? 'not_owned',
        reason,
        model: run.model,
        elapsedMs: now() - started,
        characters: text.length,
        error: cause instanceof Error ? cause.name : 'Unknown error',
      });
    } finally {
      clearInterval(heartbeat);
      clearTimeout(total);
      clearTimeout(idle!);
    }
  }
}
