import type { DB } from '../db/index.js';
// Journal reservations describe accounting liabilities, not confirmed physical bytes.
export function cleanupLiabilities(db: DB) {
  const requiredBackups = db
    .prepare(
      `SELECT backup_fingerprint backupFingerprint,count(*) objects,sum(size) reservedBytes,
    sum(state='pending') awaitingDeletion,sum(state='deleting') unacknowledgedDeletion
    FROM asset_consolidation_journal WHERE state!='deleted' GROUP BY backup_fingerprint ORDER BY backup_fingerprint`,
    )
    .all() as {
    backupFingerprint: string;
    objects: number;
    reservedBytes: number;
    awaitingDeletion: number;
    unacknowledgedDeletion: number;
  }[];
  return {
    objects: requiredBackups.reduce((n, b) => n + b.objects, 0),
    reservedBytes: requiredBackups.reduce((n, b) => n + b.reservedBytes, 0),
    requiredBackups,
    nextAction: requiredBackups.length
      ? 'Run offline consolidation cleanup with each matching original legacy backup. Verification does not release quota; absent redundant objects still require backup verification.'
      : 'No consolidation cleanup required.',
  };
}
