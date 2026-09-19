import type { DB } from '../db/index.js';
import { DomainError } from './access.js';

export interface Library {
  id: string;
  principal_id: string;
  created_at: number;
}

export function librariesFor(db: DB, principalId: string): Library[] {
  return db
    .prepare('SELECT * FROM libraries WHERE principal_id=? ORDER BY created_at,id')
    .all(principalId) as Library[];
}

export function authorizeLibrary(db: DB, principalId: string, libraryId: string): Library {
  const library = db
    .prepare('SELECT * FROM libraries WHERE id=? AND principal_id=?')
    .get(libraryId, principalId) as Library | undefined;
  if (!library) throw new DomainError(403, 'This account cannot access this library.');
  return library;
}

export function currentLibrary(db: DB, principalId: string, requested?: string): Library {
  if (requested) return authorizeLibrary(db, principalId, requested);
  const library = librariesFor(db, principalId)[0];
  if (!library) throw new DomainError(403, 'No library is available for this account.');
  return library;
}
