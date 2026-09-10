import type { DB } from '../db/index.js';
export interface RetentionPolicy {
  completedCheckpointDays: number;
  batchSize: number;
}
const day = 86400000;
// Artifact history, partial failures and billing evidence are never age-deleted.
export function maintainHistory(db: DB, policy: RetentionPolicy, time = Date.now()) {
  if (
    !Number.isInteger(policy.completedCheckpointDays) ||
    policy.completedCheckpointDays < 1 ||
    !Number.isInteger(policy.batchSize) ||
    policy.batchSize < 1 ||
    policy.batchSize > 1000
  )
    throw new Error('Invalid retention policy');
  return db.transaction(() => {
    const checkpoints = db
      .prepare(
        `DELETE FROM run_checkpoints WHERE run_id IN (
      SELECT c.run_id FROM run_checkpoints c JOIN runs r ON r.id=c.run_id
      JOIN run_outputs o ON o.run_id=r.id JOIN block_revisions v ON v.id=o.revision_id
      JOIN spend_commitments cost ON cost.run_id=r.id
      WHERE r.status='completed' AND r.finished_at<? AND c.updated_at<?
      AND cost.status IN ('confirmed','released') AND json_extract(v.content_json,'$.text')=c.text
      ORDER BY r.finished_at LIMIT ?)`,
      )
      .run(
        time - policy.completedCheckpointDays * day,
        time - policy.completedCheckpointDays * day,
        policy.batchSize,
      ).changes;
    const sessions = db
      .prepare(
        'DELETE FROM session WHERE id IN (SELECT id FROM session WHERE expiresAt<? ORDER BY expiresAt LIMIT ?)',
      )
      .run(time, policy.batchSize).changes;
    const verifications = db
      .prepare(
        'DELETE FROM verification WHERE id IN (SELECT id FROM verification WHERE expiresAt<? ORDER BY expiresAt LIMIT ?)',
      )
      .run(time, policy.batchSize).changes;
    return { checkpoints, sessions, verifications };
  })();
}
