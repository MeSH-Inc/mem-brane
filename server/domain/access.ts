import type { DB } from '../db/index.js';
export class DomainError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function requireOwned(
  db: DB,
  table: 'branes' | 'blocks' | 'runs' | 'assets' | 'conversations',
  actor: string,
  id: string,
) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id=? AND owner_id=?`).get(id, actor) as any;
  if (!row) throw new DomainError(404, 'Resource not found');
  return row;
}
export const canReadBrane = (db: DB, actor: string, id: string) =>
  requireOwned(db, 'branes', actor, id);
export const canEditBrane = canReadBrane;
export const canRunOnBrane = canReadBrane;
