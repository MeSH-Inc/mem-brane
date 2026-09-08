import { contentReader } from './representations.js';
import { randomUUID } from 'node:crypto';
import type { DB } from '../db/index.js';
import type { RunInput } from '../../shared/types/domain.js';
import type { ConversationMessage } from '../../shared/types/conversation.js';
import { DomainError } from '../domain/access.js';

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

type Reader = ReturnType<typeof fullReader>;
const fullReader = (db: DB, actor: string) => contentReader(db, actor, 'full');
export function readLineage(
  db: DB,
  actor: string,
  messageId: string,
  reader: Reader = fullReader(db, actor),
): ConversationMessage[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE lineage AS (
    SELECT id,parent_id,0 depth FROM conversation_messages WHERE id=?
    UNION ALL
    SELECT m.id,m.parent_id,child.depth+1 FROM conversation_messages m JOIN lineage child ON m.id=child.parent_id WHERE child.depth<200
  ) SELECT m.*,v.block_id,v.content_json,c.owner_id FROM lineage l
  JOIN conversation_messages m ON m.id=l.id JOIN block_revisions v ON v.id=m.revision_id
  JOIN conversations c ON c.id=m.conversation_id ORDER BY l.depth DESC`,
    )
    .all(messageId) as {
    id: string;
    parent_id: string | null;
    run_id: string;
    conversation_id: string;
    role: 'user' | 'assistant';
    revision_id: string;
    created_at: number;
    block_id: string;
    content_json: string;
    owner_id: string;
  }[];
  if (!rows.length || rows.some((row) => row.owner_id !== actor))
    throw new DomainError(404, 'Conversation point not found');
  if (rows.length > 200 || new Set(rows.map((row) => row.id)).size !== rows.length)
    throw new DomainError(400, 'Conversation lineage is too long');
  const references = db
    .prepare(
      `SELECT r.id run_id,e.label,e.revision_id FROM runs r
    JOIN context_entries e ON e.context_id=r.context_id
    WHERE r.id IN (SELECT value FROM json_each(?)) AND e.kind IN ('source','reference') ORDER BY e.position`,
    )
    .all(JSON.stringify(rows.filter((row) => row.role === 'user').map((row) => row.run_id))) as {
    run_id: string;
    label: string;
    revision_id: string;
  }[];
  const byRun = new Map<string, ConversationMessage['references']>();
  for (const { run_id, ...ref } of references) {
    const list = byRun.get(run_id) ?? [];
    list.push(ref);
    byRun.set(run_id, list);
  }
  reader.prefetch(rows.map((row) => row.content_json));
  return rows.map((row) => ({
    id: row.id,
    parent_id: row.parent_id,
    run_id: row.run_id,
    conversation_id: row.conversation_id,
    role: row.role,
    revision_id: row.revision_id,
    created_at: row.created_at,
    block_id: row.block_id,
    content: reader.read(row.content_json),
    references: row.role === 'user' ? (byRun.get(row.run_id) ?? []) : [],
  }));
}

export function lineageInputs(
  db: DB,
  actor: string,
  messages: ConversationMessage[],
  reader: Reader = fullReader(db, actor),
): RunInput[] {
  const inputs: RunInput[] = [];
  const ids = [...new Set(messages.flatMap((m) => m.references.map((r) => r.revision_id)))];
  const rows = db
    .prepare(
      `SELECT v.id,v.content_json FROM block_revisions v JOIN blocks b ON b.id=v.block_id WHERE v.id IN (SELECT value FROM json_each(?)) AND b.owner_id=?`,
    )
    .all(JSON.stringify(ids), actor) as { id: string; content_json: string }[];
  if (rows.length !== ids.length) throw new DomainError(404, 'Revision not found');
  reader.prefetch(rows.map((row) => row.content_json));
  const content = new Map(rows.map((row) => [row.id, reader.read(row.content_json)]));
  for (const message of messages) {
    for (const ref of message.references) {
      inputs.push({
        ...ref,
        content: content.get(ref.revision_id)!,
        position: inputs.length,
        kind: 'lineage_reference',
        role: 'user',
      });
    }
    inputs.push({
      position: inputs.length,
      kind: 'lineage',
      label: 'Conversation',
      role: message.role,
      revision_id: message.revision_id,
      content: message.content,
    });
  }
  return inputs;
}

export function readInputs(db: DB, runId: string): RunInput[] {
  const context = db
    .prepare(
      'SELECT c.id,c.owner_id,c.parent_message_id FROM runs r JOIN context_manifests c ON c.id=r.context_id WHERE r.id=?',
    )
    .get(runId) as { id: string; owner_id: string; parent_message_id: string | null } | undefined;
  if (!context) throw new DomainError(404, 'Run context not found');
  const reader = fullReader(db, context.owner_id);
  const inputs = context.parent_message_id
    ? lineageInputs(
        db,
        context.owner_id,
        readLineage(db, context.owner_id, context.parent_message_id, reader),
        reader,
      )
    : [];
  const local = db
    .prepare(
      'SELECT e.kind,e.label,e.role,e.revision_id,v.content_json FROM context_entries e JOIN block_revisions v ON v.id=e.revision_id WHERE e.context_id=? ORDER BY e.position',
    )
    .all(context.id) as {
    kind: ContextEntry['kind'];
    label: string;
    role: 'user';
    revision_id: string;
    content_json: string;
  }[];
  reader.prefetch(local.map((row) => row.content_json));
  for (const row of local)
    inputs.push({
      position: inputs.length,
      kind: row.kind,
      label: row.label,
      role: row.role,
      revision_id: row.revision_id,
      content: reader.read(row.content_json),
    });
  return inputs;
}
