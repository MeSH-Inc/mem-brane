import type { DB } from '../db/index.js';
import type { Block } from '../../shared/types/domain.js';
import type { UnplacedPage } from '../../shared/contracts.js';
import { DomainError } from '../domain/access.js';
import { contentReader } from './representations.js';

// Prompt-only blocks are internal frozen request material, not recoverable cards.
const card = `NOT EXISTS (
  SELECT 1 FROM block_revisions p JOIN context_entries e ON e.revision_id=p.id
  WHERE p.block_id=b.id AND e.kind='prompt'
)`;
const joins = `FROM blocks b
  LEFT JOIN block_live_state l ON l.block_id=b.id
  LEFT JOIN runs r ON r.output_block_id=b.id
  LEFT JOIN run_outputs o ON o.run_id=r.id
  LEFT JOIN block_revisions v ON v.id=o.revision_id
  LEFT JOIN run_checkpoints c ON c.run_id=r.id`;
const text = `COALESCE(json_extract(l.content_json,'$.text'),json_extract(v.content_json,'$.text'),c.text,'')`;

export function readCard(db: DB, actor: string, id: string): Block {
  const row = db
    .prepare<
      unknown[],
      {
        id: string;
        kind: Block['kind'];
        origin: Block['origin'];
        version: number | null;
        content_json: string | null;
        partial: string | null;
        message_id: string | null;
      }
    >(
      `SELECT b.id,b.kind,b.origin,l.version,COALESCE(l.content_json,v.content_json) content_json,
    c.text partial,o.message_id ${joins} WHERE b.owner_id=? AND b.id=? AND ${card}`,
    )
    .get(actor, id);
  if (!row) throw new DomainError(404, 'Card not found');
  return {
    id: row.id,
    kind: row.kind,
    origin: row.origin,
    version: row.version ?? 0,
    content: row.content_json
      ? contentReader(db, actor, 'workspace').read(row.content_json)
      : { format: 'text', text: row.partial ?? '' },
    messageId: row.message_id ?? undefined,
  };
}

export function readUnplacedCards(
  db: DB,
  actor: string,
  limit = 25,
  cursor?: string,
): UnplacedPage {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new DomainError(400, 'Card page limit must be 1..50');
  const anchor = cursor
    ? db
        .prepare<unknown[], { created_at: number; id: string }>(
          'SELECT created_at,id FROM blocks WHERE owner_id=? AND id=?',
        )
        .get(actor, cursor)
    : undefined;
  if (cursor && !anchor) throw new DomainError(400, 'Invalid card cursor');
  const rows = db
    .prepare<unknown[], UnplacedPage['items'][number]>(
      `
    SELECT b.id,b.kind,b.origin,b.created_at,substr(${text},1,160) preview ${joins}
    WHERE b.owner_id=? AND NOT EXISTS (SELECT 1 FROM placements p WHERE p.block_id=b.id)
    AND ${card} ${anchor ? 'AND (b.created_at,b.id)<(?,?)' : ''}
    ORDER BY b.created_at DESC,b.id DESC LIMIT ?
  `,
    )
    .all(...(anchor ? [actor, anchor.created_at, anchor.id, limit + 1] : [actor, limit + 1]));
  return {
    items: rows.slice(0, limit),
    nextCursor: rows.length > limit ? rows[limit - 1].id : null,
  };
}
