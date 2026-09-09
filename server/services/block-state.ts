import { z } from 'zod';
import type { DB } from '../db/index.js';
import { blockRecord, decodeJson, decodeRecord } from '../db/records.js';
import type { Edit, Content } from '../../shared/types/domain.js';
import type { SavedText } from '../../shared/contracts.js';
import { content as contentSchema } from '../../shared/schemas/index.js';
import { MAX_BLOCK_TEXT_CHARACTERS, fitsArtifactContent } from '../../shared/limits.js';
import { DomainError } from '../domain/access.js';

const blockStateRecord = blockRecord
  .extend({
    live_json: z.string().nullable(),
    version: z.number().int().nonnegative().nullable(),
    revision_id: z.string().nullable(),
    revision_json: z.string().nullable(),
    revision_created_at: z.number().int().nullable(),
  })
  .strict()
  .refine(
    (row) =>
      (row.live_json === null) === (row.version === null) &&
      (row.revision_id === null) === (row.revision_json === null) &&
      (row.revision_id === null) === (row.revision_created_at === null),
    'Incomplete block state',
  );
export type BlockState = z.infer<typeof blockStateRecord>;

/** One ownership-filtered query for live state and the relevant immutable revision. */
export function loadBlockStates(
  db: DB,
  actor: string,
  blockIds: string[],
): Map<string, BlockState> {
  const ids = [...new Set(blockIds)];
  if (!ids.length) return new Map();
  const rows = decodeRecord(
    z.array(blockStateRecord),
    db
      .prepare(
        `
    SELECT b.*,l.content_json live_json,l.version,r.id revision_id,r.content_json revision_json,r.created_at revision_created_at
    FROM blocks b LEFT JOIN block_live_state l ON l.block_id=b.id
    LEFT JOIN block_revisions r ON r.id=(SELECT v.id FROM block_revisions v WHERE v.block_id=b.id
      AND (l.block_id IS NULL OR v.source_version=l.version) ORDER BY v.created_at DESC,v.id DESC LIMIT 1)
    WHERE b.id IN (SELECT value FROM json_each(?)) AND b.owner_id=?`,
      )
      .all(JSON.stringify(ids), actor),
  );
  if (rows.length !== ids.length) throw new DomainError(404, 'Resource not found');
  return new Map(rows.map((row) => [row.id, row]));
}
export function planTextEdit(block: BlockState, edit: Edit): SavedText {
  if (block.id !== edit.blockId) throw new Error('Mismatched edit block');
  if (edit.text.length > MAX_BLOCK_TEXT_CHARACTERS)
    throw new DomainError(400, 'Artifact text exceeds the character limit');
  if (block.origin === 'generated' || !['text', 'webpage'].includes(block.kind))
    throw new DomainError(400, 'This block is not editable');
  if (block.live_json === null || block.version === null)
    throw new Error('Editable block has no live state');
  const previous = decodeJson(contentSchema, block.live_json);
  if (previous.format !== 'text' && previous.format !== 'webpage')
    throw new Error('Editable block has invalid content');
  const content = {
    ...previous,
    text: edit.text,
    ...(block.kind === 'webpage' ? { status: 'ready' as const, error: undefined } : {}),
  };
  if (!fitsArtifactContent(content))
    throw new DomainError(400, 'Artifact content exceeds the byte limit');
  if (block.version !== edit.version)
    throw new DomainError(409, 'This block changed. Reload before saving your draft.');
  return {
    version: block.version + (JSON.stringify(content) === block.live_json ? 0 : 1),
    content,
  };
}
export function snapshotState(block: BlockState, draft?: SavedText) {
  const contentJson = draft
    ? JSON.stringify(draft.content)
    : (block.live_json ?? block.revision_json);
  if (contentJson === null)
    throw new DomainError(409, 'Only finalized responses can be used as context');
  const sourceVersion = draft?.version ?? block.version ?? undefined;
  const reuse = !draft || draft.version === block.version;
  const revision =
    reuse && block.revision_id !== null && block.revision_created_at !== null
      ? { id: block.revision_id, created_at: block.revision_created_at }
      : undefined;
  return { blockId: block.id, contentJson, sourceVersion, revision };
}
export function assertSnapshotReady(block: BlockState, content: Content) {
  if (block.kind === 'webpage' && (content.format !== 'webpage' || content.status !== 'ready'))
    throw new DomainError(409, 'Webpage is not ready; paste content or wait for import');
}
