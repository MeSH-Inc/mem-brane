import { randomUUID } from 'node:crypto';
import type { DB } from '../db/index.js';

export interface ContextEntry {
  kind: 'source' | 'reference' | 'relation' | 'prompt';
  label: string;
  role: 'user';
  revisionId: string;
  // A relation entry's structure: the positions of the two entries it joins, and the word.
  relation?: { label: string; from: number; to: number };
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
  const relate = db.prepare('INSERT INTO relation_entries VALUES (?,?,?,?,?)');
  entries.forEach((entry, position) => {
    insert.run(id, position, entry.kind, entry.label, entry.role, entry.revisionId);
    if (entry.relation)
      relate.run(id, position, entry.relation.from, entry.relation.to, entry.relation.label);
  });
  // Inserting the first run referencing this context seals it at the DB boundary.
  return id;
}
