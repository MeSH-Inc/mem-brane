import { isGuestLibrary } from './guest-limits.js';
import { config } from '../app/config.js';
import type { DB } from '../db/index.js';
import { DomainError } from '../domain/access.js';
export interface StorageLimits {
  userBytes: number;
  totalBytes: number;
}
// Reserve bytes before asynchronous storage work; failed/uncertain writes keep their intent.
export function reserveUpload(
  db: DB,
  actor: string,
  id: string,
  size: number,
  limits: StorageLimits,
) {
  db.transaction(() => {
    if (isGuestLibrary(db, actor)) {
      limits = { ...limits, userBytes: Math.min(limits.userBytes, config.GUEST_STORAGE_BYTES) };
      const { total } = db
        .prepare(
          `SELECT COALESCE(SUM(size),0) total FROM (
        SELECT owner_id,size FROM assets UNION ALL SELECT owner_id,size FROM upload_intents
        UNION ALL SELECT library_id AS owner_id,size FROM guest_object_deletions
      ) a JOIN guest_libraries g ON g.library_id=a.owner_id WHERE g.claimed_by IS NULL`,
        )
        .get() as { total: number };
      if (total + size > config.GUEST_TOTAL_STORAGE_BYTES)
        throw new DomainError(429, 'Guest upload capacity reached. Sign in or try again later.');
    }
    const usage = db
      .prepare(
        `SELECT COALESCE(SUM(size),0) total, COALESCE(SUM(CASE WHEN owner_id IN (SELECT id FROM libraries WHERE principal_id=(SELECT principal_id FROM libraries WHERE id=?)) THEN size ELSE 0 END),0) actor FROM (SELECT owner_id,size FROM assets UNION ALL SELECT owner_id,size FROM upload_intents UNION ALL SELECT a.owner_id,j.size FROM asset_consolidation_journal j JOIN assets a ON a.id=j.canonical_id WHERE j.state!='deleted' UNION ALL SELECT library_id AS owner_id,size FROM guest_object_deletions)`,
      )
      .get(actor) as { total: number; actor: number };
    if (usage.total + size > limits.totalBytes || usage.actor + size > limits.userBytes)
      throw new DomainError(429, 'Artifact storage capacity reached');
    db.prepare('INSERT INTO upload_intents (id,owner_id,size,created_at) VALUES (?,?,?,?)').run(
      id,
      actor,
      size,
      Date.now(),
    );
  }).immediate();
}
export function admitImport(db: DB, actor: string, userLimit: number, totalLimit: number) {
  const count = db
    .prepare(
      `SELECT count(*) total, COALESCE(SUM(CASE WHEN b.owner_id IN (SELECT id FROM libraries WHERE principal_id=(SELECT principal_id FROM libraries WHERE id=?)) THEN 1 ELSE 0 END),0) actor FROM ingestions i JOIN blocks b ON b.id=i.block_id WHERE i.status IN ('queued','running')`,
    )
    .get(actor) as { total: number; actor: number };
  if (count.total >= totalLimit || count.actor >= userLimit)
    throw new DomainError(429, 'Import queue capacity reached');
}
