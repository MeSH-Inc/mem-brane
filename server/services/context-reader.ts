import { z } from 'zod';
import type { DB } from '../db/index.js';
import { decodeRecord } from '../db/records.js';
import type { RunInput, Edit } from '../../shared/types/domain.js';
import type { ConversationMessage } from '../../shared/types/conversation.js';
import { DomainError } from '../domain/access.js';
import { contentReader } from './representations.js';
import {
  loadBlockStates,
  planTextEdit,
  snapshotState,
  assertSnapshotReady,
} from './block-state.js';

const lineageRecord = z
  .object({
    id: z.string(),
    parent_id: z.string().nullable(),
    run_id: z.string(),
    conversation_id: z.string(),
    role: z.enum(['user', 'assistant']),
    revision_id: z.string(),
    created_at: z.number().int(),
    block_id: z.string(),
    content_json: z.string(),
    owner_id: z.string(),
    revision_owner_id: z.string(),
  })
  .strict();
const referenceRecord = z
  .object({
    run_id: z.string(),
    label: z.string(),
    revision_id: z.string(),
    content_json: z.string(),
    owner_id: z.string(),
    revision_owner_id: z.string(),
  })
  .strict();
const entryRecord = z
  .object({
    kind: z.enum(['source', 'reference', 'prompt']),
    label: z.string(),
    role: z.literal('user'),
    revision_id: z.string(),
    content_json: z.string(),
    revision_owner_id: z.string(),
  })
  .strict();
const contextRecord = z
  .object({ id: z.string(), owner_id: z.string(), parent_message_id: z.string().nullable() })
  .strict();
const revisionContentRecord = z.object({ id: z.string(), content_json: z.string() }).strict();
type Lineage = {
  messages: z.infer<typeof lineageRecord>[];
  references: z.infer<typeof referenceRecord>[];
};

/** Request-scoped ownership and hydration boundary for planned and committed context. */
export function contextReader(db: DB, actor: string) {
  const reader = contentReader(db, actor, 'full');
  function loadLineage(messageId?: string): Lineage {
    if (!messageId) return { messages: [], references: [] };
    const messages = decodeRecord(
      z.array(lineageRecord),
      db
        .prepare(
          `WITH RECURSIVE lineage AS (
      SELECT id,parent_id,0 depth FROM conversation_messages WHERE id=? UNION ALL
      SELECT m.id,m.parent_id,child.depth+1 FROM conversation_messages m JOIN lineage child ON m.id=child.parent_id WHERE child.depth<200
    ) SELECT m.*,v.block_id,v.content_json,c.owner_id,b.owner_id revision_owner_id FROM lineage l
      JOIN conversation_messages m ON m.id=l.id JOIN block_revisions v ON v.id=m.revision_id
      JOIN blocks b ON b.id=v.block_id JOIN conversations c ON c.id=m.conversation_id ORDER BY l.depth DESC`,
        )
        .all(messageId),
    );
    if (
      !messages.length ||
      messages.some((row) => row.owner_id !== actor || row.revision_owner_id !== actor)
    )
      throw new DomainError(404, 'Conversation point not found');
    if (messages.length > 200 || new Set(messages.map((row) => row.id)).size !== messages.length)
      throw new DomainError(400, 'Conversation lineage is too long');
    const references = decodeRecord(
      z.array(referenceRecord),
      db
        .prepare(
          `
      SELECT r.id run_id,r.owner_id,e.label,e.revision_id,v.content_json,b.owner_id revision_owner_id FROM runs r
      JOIN context_entries e ON e.context_id=r.context_id JOIN block_revisions v ON v.id=e.revision_id JOIN blocks b ON b.id=v.block_id
      WHERE r.id IN (SELECT value FROM json_each(?)) AND e.kind IN ('source','reference') ORDER BY e.position`,
        )
        .all(
          JSON.stringify(messages.filter((row) => row.role === 'user').map((row) => row.run_id)),
        ),
    );
    if (references.some((row) => row.owner_id !== actor || row.revision_owner_id !== actor))
      throw new DomainError(404, 'Revision not found');
    return { messages, references };
  }
  const lineageJsons = (lineage: Lineage) =>
    [...lineage.messages, ...lineage.references].map((row) => row.content_json);
  function hydrateLineage(lineage: Lineage): ConversationMessage[] {
    const byRun = new Map<string, ConversationMessage['references']>();
    for (const ref of lineage.references) {
      const list = byRun.get(ref.run_id) ?? [];
      list.push({ label: ref.label, revision_id: ref.revision_id });
      byRun.set(ref.run_id, list);
    }
    return lineage.messages.map((row) => ({
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
  function expand(lineage: Lineage, messages: ConversationMessage[]): RunInput[] {
    const contents = new Map(
      lineage.references.map((ref) => [ref.revision_id, reader.read(ref.content_json)]),
    );
    return expandMessages(messages, contents);
  }
  return {
    plan(blockIds: string[], edits: Edit[], parent?: string) {
      const blocks = loadBlockStates(db, actor, [
        ...blockIds,
        ...edits.map((edit) => edit.blockId),
      ]);
      const drafts = new Map(
        edits.map((edit) => [edit.blockId, planTextEdit(blocks.get(edit.blockId)!, edit)]),
      );
      const snapshots = [...new Set(blockIds)].map((id) =>
        snapshotState(blocks.get(id)!, drafts.get(id)),
      );
      const lineage = loadLineage(parent);
      reader.prefetch([...snapshots.map((item) => item.contentJson), ...lineageJsons(lineage)]);
      const candidates = new Map(
        snapshots.map((item) => {
          const content = reader.read(item.contentJson);
          assertSnapshotReady(blocks.get(item.blockId)!, content);
          return [item.blockId, { ...item, content }];
        }),
      );
      const messages = hydrateLineage(lineage);
      return {
        candidates,
        conversationId: messages.at(-1)?.conversation_id,
        inputs: expand(lineage, messages),
      };
    },
    lineage(messageId: string) {
      const lineage = loadLineage(messageId);
      reader.prefetch(lineageJsons(lineage));
      return hydrateLineage(lineage);
    },
    inputs(contextId: string, parent?: string): RunInput[] {
      const lineage = loadLineage(parent);
      const local = decodeRecord(
        z.array(entryRecord),
        db
          .prepare(
            `SELECT e.kind,e.label,e.role,e.revision_id,v.content_json,b.owner_id revision_owner_id
        FROM context_entries e JOIN block_revisions v ON v.id=e.revision_id JOIN blocks b ON b.id=v.block_id WHERE e.context_id=? ORDER BY e.position`,
          )
          .all(contextId),
      );
      if (local.some((row) => row.revision_owner_id !== actor))
        throw new DomainError(404, 'Revision not found');
      reader.prefetch([...lineageJsons(lineage), ...local.map((row) => row.content_json)]);
      const inputs = expand(lineage, hydrateLineage(lineage));
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
    },
  };
}
function expandMessages(
  messages: ConversationMessage[],
  contents: Map<string, RunInput['content']>,
): RunInput[] {
  const inputs: RunInput[] = [];
  for (const message of messages) {
    for (const ref of message.references) {
      const content = contents.get(ref.revision_id);
      if (!content) throw new DomainError(404, 'Revision not found');
      inputs.push({
        ...ref,
        content,
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
export function readLineage(db: DB, actor: string, messageId: string): ConversationMessage[] {
  return contextReader(db, actor).lineage(messageId);
}
export function lineageInputs(db: DB, actor: string, messages: ConversationMessage[]): RunInput[] {
  const ids = [
    ...new Set(messages.flatMap((message) => message.references.map((ref) => ref.revision_id))),
  ];
  const rows = ids.length
    ? decodeRecord(
        z.array(revisionContentRecord),
        db
          .prepare(
            `SELECT v.id,v.content_json FROM block_revisions v JOIN blocks b ON b.id=v.block_id
    WHERE v.id IN (SELECT value FROM json_each(?)) AND b.owner_id=?`,
          )
          .all(JSON.stringify(ids), actor),
      )
    : [];
  if (rows.length !== ids.length) throw new DomainError(404, 'Revision not found');
  const reader = contentReader(db, actor, 'full');
  reader.prefetch(rows.map((row) => row.content_json));
  return expandMessages(
    messages,
    new Map(rows.map((row) => [row.id, reader.read(row.content_json)])),
  );
}
export function readInputs(db: DB, runId: string): RunInput[] {
  const raw = db
    .prepare(
      'SELECT c.id,c.owner_id,c.parent_message_id FROM runs r JOIN context_manifests c ON c.id=r.context_id WHERE r.id=?',
    )
    .get(runId);
  if (!raw) throw new DomainError(404, 'Run context not found');
  const context = decodeRecord(contextRecord, raw);
  return contextReader(db, context.owner_id).inputs(
    context.id,
    context.parent_message_id ?? undefined,
  );
}
