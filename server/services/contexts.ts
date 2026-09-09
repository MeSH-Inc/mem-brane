import { randomUUID } from 'node:crypto';
import type { DB } from '../db/index.js';

export interface ContextEntry {
  kind: 'source' | 'reference' | 'prompt';
  label: string;
  role: 'user';
  revisionId: string;
}

export function createContext(
  db: DB,
  actor: string,
  parent: string | undefined,
  entries: ContextEntry[],
): string {
  const id = randomUUID();
  db.prepare('INSERT INTO context_manifests VALUES (?,?,?)').run(id, actor, parent ?? null);
  const insert = db.prepare('INSERT INTO context_entries VALUES (?,?,?,?,?,?)');
  entries.forEach((entry, position) =>
    insert.run(id, position, entry.kind, entry.label, entry.role, entry.revisionId),
  );
  // Inserting the first run referencing this context seals it at the DB boundary.
  return id;
}
