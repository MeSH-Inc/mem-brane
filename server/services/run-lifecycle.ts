import type { DB } from '../db/index.js';
import { decodeRecord, runRecord, type RunRecord } from '../db/records.js';
import { requireOwned } from '../domain/access.js';
import { now, uid } from './content.js';
import {
  settleCost,
  holdUncertainCost,
  releaseUninvokedCost,
  releaseFailedPreflightCost,
} from './costs.js';
import type { ModelResult } from '../llm/model.js';
import { fitsArtifactContent } from '../../shared/limits.js';

/** A lease and its attempt fence every write made by an executing worker. */
export interface AttemptToken {
  runId: string;
  workerId: string;
  attemptId: string;
}
function ownedAttempt(db: DB, token: AttemptToken, time: number): RunRecord | null {
  const row = db
    .prepare(
      `SELECT r.* FROM runs r JOIN run_attempts a ON a.run_id=r.id
    WHERE r.id=? AND r.lease_owner=? AND r.lease_until>? AND r.status IN ('running','cancel_requested')
    AND a.id=? AND a.worker_id=? AND a.finished_at IS NULL`,
    )
    .get(token.runId, token.workerId, time, token.attemptId, token.workerId);
  return row ? decodeRecord(runRecord, row) : null;
}
function checkpoint(db: DB, runId: string, text: string, time: number) {
  if (!fitsArtifactContent({ text })) throw new Error('Generated text exceeds the character limit');
  db.prepare(
    'INSERT INTO run_checkpoints VALUES (?,?,?) ON CONFLICT(run_id) DO UPDATE SET text=excluded.text,updated_at=excluded.updated_at',
  ).run(runId, text, time);
}
export function startAttempt(
  db: DB,
  runId: string,
  workerId: string,
  time = now(),
): AttemptToken | null {
  return db
    .transaction(() => {
      const changed = db
        .prepare(
          "UPDATE runs SET status='running',started_at=? WHERE id=? AND status='claimed' AND lease_owner=? AND lease_until>?",
        )
        .run(time, runId, workerId, time);
      if (!changed.changes) return null;
      const attemptId = uid();
      db.prepare(
        'INSERT INTO run_attempts (id,run_id,worker_id,started_at,heartbeat_at) VALUES (?,?,?,?,?)',
      ).run(attemptId, runId, workerId, time, time);
      return { runId, workerId, attemptId };
    })
    .immediate();
}
export function renewAttempt(db: DB, token: AttemptToken, leaseMs: number, time = now()): boolean {
  return db
    .transaction(() => {
      if (ownedAttempt(db, token, time)?.status !== 'running') return false;
      db.prepare('UPDATE runs SET lease_until=? WHERE id=?').run(time + leaseMs, token.runId);
      db.prepare('UPDATE run_attempts SET heartbeat_at=? WHERE id=?').run(time, token.attemptId);
      return true;
    })
    .immediate();
}
export function saveCheckpoint(db: DB, token: AttemptToken, text: string, time = now()): boolean {
  return db
    .transaction(() => {
      if (ownedAttempt(db, token, time)?.status !== 'running') return false;
      checkpoint(db, token.runId, text, time);
      return true;
    })
    .immediate();
}
export function cancelRun(db: DB, actor: string, id: string, time = now()) {
  return db
    .transaction(() => {
      const run = requireOwned(db, 'runs', actor, id);
      if (run.status === 'queued' || run.status === 'claimed') {
        db.prepare(
          "UPDATE runs SET status='cancelled',finished_at=?,lease_owner=NULL,lease_until=NULL WHERE id=?",
        ).run(time, id);
        releaseUninvokedCost(db, id);
      } else if (run.status === 'running') {
        db.prepare("UPDATE runs SET status='cancel_requested' WHERE id=?").run(id);
      }
    })
    .immediate();
}
export function recoverStale(db: DB, time = now()) {
  return db
    .transaction(() => {
      const stale = db
        .prepare(
          "SELECT * FROM runs WHERE lease_until<=? AND status IN ('claimed','running','cancel_requested')",
        )
        .all(time)
        .map((row) => decodeRecord(runRecord, row));
      return stale.map((run) => {
        const status: RunRecord['status'] =
          run.status === 'claimed'
            ? 'queued'
            : run.status === 'cancel_requested'
              ? 'cancelled'
              : 'interrupted';
        if (status !== 'queued') {
          if (db.prepare('SELECT 1 FROM run_attempts WHERE run_id=?').get(run.id))
            holdUncertainCost(db, run.id);
          else releaseUninvokedCost(db, run.id);
          db.prepare(
            'UPDATE run_attempts SET finished_at=?,outcome=? WHERE run_id=? AND finished_at IS NULL',
          ).run(time, status, run.id);
        }
        db.prepare(
          'UPDATE runs SET status=?,error=?,finished_at=?,lease_owner=NULL,lease_until=NULL WHERE id=?',
        ).run(
          status,
          status === 'queued' ? null : 'Worker lease expired; provider completion is uncertain',
          status === 'queued' ? null : time,
          run.id,
        );
        return { ...run, status };
      });
    })
    .immediate();
}
export function stopAttempt(
  db: DB,
  token: AttemptToken,
  text: string,
  reason: 'failed' | 'preflight' | 'shutdown',
  time = now(),
) {
  return db
    .transaction(() => {
      const run = ownedAttempt(db, token, time);
      if (!run) return null;
      const status =
        run.status === 'cancel_requested'
          ? 'cancelled'
          : reason === 'shutdown'
            ? 'interrupted'
            : 'failed';
      checkpoint(db, run.id, text, time);
      if (reason === 'preflight') releaseFailedPreflightCost(db, run.id);
      else holdUncertainCost(db, run.id);
      const error =
        status === 'cancelled'
          ? null
          : reason === 'preflight'
            ? 'Model preparation failed; no provider call was made'
            : status === 'interrupted'
              ? 'Server stopped; provider completion is uncertain'
              : 'Model request failed; completion or billing may be uncertain';
      db.prepare(
        'UPDATE runs SET status=?,error=?,finished_at=?,lease_owner=NULL,lease_until=NULL WHERE id=?',
      ).run(status, error, time, run.id);
      db.prepare('UPDATE run_attempts SET finished_at=?,outcome=? WHERE id=?').run(
        time,
        status,
        token.attemptId,
      );
      return status;
    })
    .immediate();
}
export function completeAttempt(
  db: DB,
  token: AttemptToken,
  result: ModelResult,
  time = now(),
): boolean {
  return db
    .transaction(() => {
      const run = ownedAttempt(db, token, time);
      if (!run || run.status !== 'running') return false;
      checkpoint(db, run.id, result.text, time);
      const revisionId = uid(),
        userMessage = uid(),
        assistantMessage = uid();
      db.prepare(
        'INSERT INTO block_revisions (id,block_id,content_json,created_at) VALUES (?,?,?,?)',
      ).run(
        revisionId,
        run.output_block_id,
        JSON.stringify({ format: 'text', text: result.text }),
        time,
      );
      const context = db
        .prepare(
          "SELECT c.parent_message_id,e.revision_id FROM context_manifests c JOIN context_entries e ON e.context_id=c.id AND e.kind='prompt' WHERE c.id=?",
        )
        .get(run.context_id) as { parent_message_id: string | null; revision_id: string };
      db.prepare(
        'INSERT INTO conversation_messages (id,conversation_id,parent_id,role,revision_id,created_at,run_id) VALUES (?,?,?,?,?,?,?)',
      ).run(
        userMessage,
        run.conversation_id,
        context.parent_message_id,
        'user',
        context.revision_id,
        time,
        run.id,
      );
      db.prepare(
        'INSERT INTO conversation_messages (id,conversation_id,parent_id,role,revision_id,created_at,run_id) VALUES (?,?,?,?,?,?,?)',
      ).run(
        assistantMessage,
        run.conversation_id,
        userMessage,
        'assistant',
        revisionId,
        time,
        run.id,
      );
      db.prepare('INSERT INTO run_outputs VALUES (?,?,?)').run(
        run.id,
        revisionId,
        assistantMessage,
      );
      db.prepare(
        "UPDATE runs SET status='completed',usage_json=?,finished_at=?,lease_owner=NULL,lease_until=NULL WHERE id=?",
      ).run(result.usage ? JSON.stringify(result.usage) : null, time, run.id);
      db.prepare("UPDATE run_attempts SET finished_at=?,outcome='completed' WHERE id=?").run(
        time,
        token.attemptId,
      );
      settleCost(db, run.id, result.usage, run.model === 'mock');

      return true;
    })
    .immediate();
}
export function claimRun(db: DB, workerId: string, leaseMs: number, time = now()) {
  return db
    .transaction(() => {
      const row = db
        .prepare("SELECT * FROM runs WHERE status='queued' ORDER BY created_at LIMIT 1")
        .get();
      if (!row) return null;
      const run = decodeRecord(runRecord, row);
      const leaseUntil = time + leaseMs;
      const claimed = db
        .prepare(
          "UPDATE runs SET status='claimed',lease_owner=?,lease_until=? WHERE id=? AND status='queued'",
        )
        .run(workerId, leaseUntil, run.id);
      return claimed.changes
        ? { ...run, status: 'claimed' as const, lease_owner: workerId, lease_until: leaseUntil }
        : null;
    })
    .immediate();
}
