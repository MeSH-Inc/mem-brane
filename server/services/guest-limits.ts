import type { DB } from '../db/index.js';
import { config } from '../app/config.js';
import { DomainError } from '../domain/access.js';

export function isGuestLibrary(db: DB, libraryId: string) {
  return !!db
    .prepare('SELECT 1 FROM guest_libraries WHERE library_id=? AND claimed_by IS NULL')
    .get(libraryId);
}
export function guestCapacity(db: DB, libraryId: string, kind: 'brane' | 'block' | 'operation') {
  if (!isGuestLibrary(db, libraryId)) return;
  const [table, limit] =
    kind === 'brane'
      ? ['branes', 3]
      : kind === 'block'
        ? ['blocks', config.GUEST_MAX_BLOCKS]
        : ['workspace_operations', config.GUEST_MAX_OPERATIONS];
  const { n } = db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE owner_id=?`).get(libraryId) as {
    n: number;
  };
  if (n >= Number(limit))
    throw new DomainError(429, 'Guest workspace limit reached. Sign in to keep working.');
}
export function guestTextCapacity(db: DB, libraryId: string, text: string, blockId?: string) {
  if (!isGuestLibrary(db, libraryId)) return;
  const { n } = db
    .prepare(
      `SELECT COALESCE(SUM(length(json_extract(s.content_json,'$.text'))),0) n
    FROM block_live_state s JOIN blocks b ON b.id=s.block_id WHERE b.owner_id=? AND b.id!=?`,
    )
    .get(libraryId, blockId ?? '') as { n: number };
  if (text.length > 20000 || n + text.length > 200000)
    throw new DomainError(413, 'Guest text limit reached. Sign in to keep working.');
}
