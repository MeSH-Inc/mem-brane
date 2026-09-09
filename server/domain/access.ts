import { decodeRecord, ownedRecords, type OwnedRecords } from '../db/records.js';
import type { DB } from '../db/index.js';
export class DomainError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 503,
    message: string,
  ) {
    super(message);
  }
}
export function requireOwned<K extends keyof OwnedRecords>(
  db: DB,
  table: K,
  actor: string,
  id: string,
): OwnedRecords[K] {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id=? AND owner_id=?`).get(id, actor);
  if (!row) throw new DomainError(404, 'Resource not found');
  // The runtime schema is selected by the same table key as the return type.
  return decodeRecord(ownedRecords[table], row) as OwnedRecords[K];
}
export const canReadBrane = (db: DB, actor: string, id: string) =>
  requireOwned(db, 'branes', actor, id);
export const canEditBrane = canReadBrane;
export const canRunOnBrane = canReadBrane;
