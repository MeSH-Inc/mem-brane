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
    const usage = db
      .prepare(
        `SELECT COALESCE(SUM(size),0) total, COALESCE(SUM(CASE WHEN owner_id=? THEN size ELSE 0 END),0) actor FROM (SELECT owner_id,size FROM assets UNION ALL SELECT owner_id,size FROM upload_intents)`,
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
      `SELECT count(*) total, COALESCE(SUM(CASE WHEN b.owner_id=? THEN 1 ELSE 0 END),0) actor FROM ingestions i JOIN blocks b ON b.id=i.block_id WHERE i.status IN ('queued','running')`,
    )
    .get(actor) as { total: number; actor: number };
  if (count.total >= totalLimit || count.actor >= userLimit)
    throw new DomainError(429, 'Import queue capacity reached');
}
