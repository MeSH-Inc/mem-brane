import {
  MAX_BRANE_PLACEMENTS,
  MAX_BLOCK_TEXT_CHARACTERS,
  fitsArtifactContent,
} from '../../shared/limits.js';
import { content as contentSchema } from '../../shared/schemas/index.js';
import { randomUUID } from 'node:crypto';
import type { DB } from '../db/index.js';
import type {
  BlockKind,
  Content,
  Edit,
  Revision,
  Placement,
  Geometry,
  BraneState,
  Block,
  Run,
  Derivation,
} from '../../shared/types/domain.js';
import type { RevisionPage } from '../../shared/types/history.js';
import { canEditBrane, canReadBrane, DomainError, requireOwned } from '../domain/access.js';
export const uid = () => randomUUID();
export const now = () => Date.now();
export function createBrane(db: DB, actor: string, title = 'Untitled brane') {
  if (
    (db.prepare('SELECT count(*) n FROM branes WHERE owner_id=?').get(actor) as { n: number }).n >=
    100
  )
    throw new DomainError(429, 'Workspace capacity reached');
  const id = uid(),
    time = now();
  db.prepare('INSERT INTO branes VALUES (?,?,?,?,?)').run(id, actor, title, time, time);
  return { id, title, created_at: time, updated_at: time };
}
export function createPlacement(
  db: DB,
  actor: string,
  braneId: string,
  blockId: string,
  g = { x: 100, y: 100, width: 320, height: 220 },
) {
  canEditBrane(db, actor, braneId);
  requireOwned(db, 'blocks', actor, blockId);
  if (
    (db.prepare('SELECT count(*) n FROM placements WHERE brane_id=?').get(braneId) as { n: number })
      .n >= MAX_BRANE_PLACEMENTS
  )
    throw new DomainError(429, 'Brane placement capacity reached');
  const id = uid();
  db.prepare(
    'INSERT INTO placements (id,brane_id,block_id,x,y,width,height,z_index,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run(id, braneId, blockId, g.x, g.y, g.width, g.height, 0, now());
  return db.prepare('SELECT * FROM placements WHERE id=?').get(id) as any;
}
export function createBlock(
  db: DB,
  actor: string,
  kind: BlockKind,
  content: Content,
  braneId?: string,
  geometry?: { x: number; y: number; width: number; height: number },
  origin: 'authored' | 'generated' = 'authored',
) {
  if (!fitsArtifactContent(content))
    throw new DomainError(400, 'Artifact text exceeds the character limit');
  content = contentSchema.parse(content);
  if (kind !== content.format) throw new DomainError(400, 'Block kind must match content format');
  return db.transaction(() => {
    const id = uid();
    db.prepare('INSERT INTO blocks (id,owner_id,kind,created_at,origin) VALUES (?,?,?,?,?)').run(
      id,
      actor,
      kind,
      now(),
      origin,
    );
    if (origin === 'authored')
      db.prepare('INSERT INTO block_live_state VALUES (?,?,0,?)').run(
        id,
        JSON.stringify(content),
        now(),
      );
    const placement = braneId ? createPlacement(db, actor, braneId, id, geometry) : undefined;
    return { id, kind, origin, content, version: 0, placement };
  })();
}
export function createTextBlock(
  db: DB,
  actor: string,
  braneId: string,
  geometry?: { x: number; y: number; width: number; height: number },
) {
  return createBlock(db, actor, 'text', { format: 'text', text: '' }, braneId, geometry);
}
export function updateBlockLiveState(db: DB, actor: string, edit: Edit) {
  const block = requireOwned(db, 'blocks', actor, edit.blockId);
  if (edit.text.length > MAX_BLOCK_TEXT_CHARACTERS)
    throw new DomainError(400, 'Artifact text exceeds the character limit');
  if (block.origin === 'generated' || !['text', 'webpage'].includes(block.kind))
    throw new DomainError(400, 'This block is not editable');
  const state = db
    .prepare('SELECT * FROM block_live_state WHERE block_id=?')
    .get(edit.blockId) as any;
  const content = {
    ...JSON.parse(state.content_json),
    text: edit.text,
    ...(block.kind === 'webpage' ? { status: 'ready', error: undefined } : {}),
  };
  if (!fitsArtifactContent(content))
    throw new DomainError(400, 'Artifact content exceeds the byte limit');
  if (state.version !== edit.version)
    throw new DomainError(409, 'This block changed. Reload before saving your draft.');
  if (JSON.stringify(content) === state.content_json) return { version: state.version, content };
  const result = db
    .prepare(
      'UPDATE block_live_state SET content_json=?, version=version+1, updated_at=? WHERE block_id=? AND version=?',
    )
    .run(JSON.stringify(content), now(), edit.blockId, edit.version);
  if (!result.changes)
    throw new DomainError(409, 'This block changed. Reload before saving your draft.');
  if (block.kind === 'webpage')
    db.prepare("UPDATE ingestions SET status='manual' WHERE block_id=?").run(edit.blockId);
  return { version: edit.version + 1, content };
}
export interface RevisionService {
  snapshotBlock(actor: string, blockId: string): Revision;
}
export function revisions(db: DB): RevisionService {
  return {
    snapshotBlock: db.transaction((actor: string, blockId: string): Revision => {
      const block = requireOwned(db, 'blocks', actor, blockId);
      const live = db
        .prepare('SELECT content_json,version FROM block_live_state WHERE block_id=?')
        .get(blockId) as any;
      if (!live) {
        const existing = db
          .prepare(
            'SELECT * FROM block_revisions WHERE block_id=? ORDER BY created_at DESC LIMIT 1',
          )
          .get(blockId) as any;
        if (!existing)
          throw new DomainError(409, 'Only finalized responses can be used as context');
        return revisionDto(existing);
      }
      const content: Content = JSON.parse(live.content_json);
      if (block.kind === 'webpage' && content.status !== 'ready')
        throw new DomainError(409, 'Webpage is not ready; paste content or wait for import');
      const existing = db
        .prepare('SELECT * FROM block_revisions WHERE block_id=? AND source_version=?')
        .get(blockId, live.version) as RevisionRow | undefined;
      if (existing) return revisionDto(existing);
      const revision = { id: uid(), block_id: blockId, content, created_at: now() };
      db.prepare(
        'INSERT INTO block_revisions (id,block_id,content_json,created_at,source_version) VALUES (?,?,?,?,?)',
      ).run(revision.id, blockId, live.content_json, revision.created_at, live.version);
      return revision;
    }),
  };
}
interface RevisionRow {
  id: string;
  block_id: string;
  content_json: string;
  created_at: number;
}
function revisionDto(row: RevisionRow): Revision {
  return {
    id: row.id,
    block_id: row.block_id,
    content: JSON.parse(row.content_json),
    created_at: row.created_at,
  };
}
export function readRevision(db: DB, actor: string, id: string): Revision {
  const row = db
    .prepare('SELECT id,block_id,content_json,created_at FROM block_revisions WHERE id=?')
    .get(id) as RevisionRow | undefined;
  if (!row) throw new DomainError(404, 'Revision not found');
  requireOwned(db, 'blocks', actor, row.block_id);
  return revisionDto(row);
}
export function readRevisionPage(
  db: DB,
  actor: string,
  blockId: string,
  limit = 25,
  cursor?: string,
): RevisionPage {
  requireOwned(db, 'blocks', actor, blockId);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new DomainError(400, 'Revision page limit must be 1..50');
  const anchor = cursor
    ? (db
        .prepare('SELECT created_at,id FROM block_revisions WHERE block_id=? AND id=?')
        .get(blockId, cursor) as { created_at: number; id: string } | undefined)
    : undefined;
  if (cursor && !anchor) throw new DomainError(400, 'Invalid revision cursor');
  const rows = (
    anchor
      ? db
          .prepare(
            'SELECT id,block_id,content_json,created_at FROM block_revisions WHERE block_id=? AND (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT ?',
          )
          .all(blockId, anchor.created_at, anchor.id, limit + 1)
      : db
          .prepare(
            'SELECT id,block_id,content_json,created_at FROM block_revisions WHERE block_id=? ORDER BY created_at DESC,id DESC LIMIT ?',
          )
          .all(blockId, limit + 1)
  ) as RevisionRow[];
  return {
    items: rows.slice(0, limit).map(revisionDto),
    nextCursor: rows.length > limit ? rows[limit - 1].id : null,
  };
}
export function getPlacement(db: DB, actor: string, id: string): Placement {
  const placement = db.prepare('SELECT * FROM placements WHERE id=?').get(id) as
    Placement | undefined;
  if (!placement) throw new DomainError(404, 'Placement not found');
  canReadBrane(db, actor, placement.brane_id);
  return placement;
}
export function updatePlacementGeometry(
  db: DB,
  actor: string,
  id: string,
  edit: Geometry & { version: number },
): Placement {
  const placement = getPlacement(db, actor, id);
  canEditBrane(db, actor, placement.brane_id);
  const result = db
    .prepare(
      `UPDATE placements SET x=?,y=?,width=?,height=?,
    updated_at=?,version=version+1 WHERE id=? AND version=? RETURNING *`,
    )
    .get(edit.x, edit.y, edit.width, edit.height, now(), id, edit.version) as Placement | undefined;
  if (!result)
    throw new DomainError(
      409,
      'This placement changed elsewhere. Review your move before retrying.',
    );
  return result;
}
export function removePlacement(db: DB, actor: string, id: string) {
  const p = db.prepare('SELECT * FROM placements WHERE id=?').get(id) as any;
  if (!p) throw new DomainError(404, 'Placement not found');
  canEditBrane(db, actor, p.brane_id);
  db.prepare('DELETE FROM placements WHERE id=?').run(id);
}
export function readBrane(db: DB, actor: string, id: string): BraneState {
  const owned = canReadBrane(db, actor, id);
  const brane = {
    id: owned.id,
    title: owned.title,
    created_at: owned.created_at,
    updated_at: owned.updated_at,
  };
  const placements = db
    .prepare(
      'SELECT id,brane_id,block_id,x,y,width,height,z_index,version FROM placements WHERE brane_id=? ORDER BY z_index,updated_at',
    )
    .all(id) as Placement[];
  const blocks = (
    db
      .prepare(
        `SELECT b.id,b.kind,b.origin,l.content_json,l.version,v.content_json final_content,o.message_id
        FROM blocks b LEFT JOIN block_live_state l ON l.block_id=b.id
        LEFT JOIN runs r ON r.output_block_id=b.id
        LEFT JOIN run_outputs o ON o.run_id=r.id
        LEFT JOIN block_revisions v ON v.id=o.revision_id
        WHERE b.id IN (SELECT block_id FROM placements WHERE brane_id=?)
        ORDER BY b.created_at,b.id`,
      )
      .all(id) as any[]
  ).map((b): Block => {
    return {
      id: b.id,
      kind: b.kind,
      origin: b.origin,
      version: b.version ?? 0,
      content: JSON.parse(b.content_json ?? b.final_content ?? '{"format":"text","text":""}'),
      messageId: b.message_id,
    };
  });
  const runs = db
    .prepare(
      "SELECT r.id,r.brane_id,r.status,r.model,r.provider,r.output_block_id,COALESCE(c.text,'') partial,r.error,r.usage_json,r.retry_of,r.created_at FROM runs r LEFT JOIN run_checkpoints c ON c.run_id=r.id AND r.status!='completed' WHERE r.brane_id=? AND (r.output_block_id IN (SELECT block_id FROM placements WHERE brane_id=?) OR r.status IN ('queued','claimed','running','cancel_requested') OR r.id IN (SELECT id FROM runs WHERE brane_id=? ORDER BY created_at DESC,id DESC LIMIT 100)) ORDER BY r.created_at,r.id",
    )
    .all(id, id, id) as Run[];
  const derivations = db
    .prepare(
      `
    SELECT i.run_id runId, v.block_id sourceBlockId, i.revision_id sourceRevisionId,
      r.output_block_id outputBlockId, i.position,
      l.anchor_placement_id anchorPlacementId, l.output_placement_id outputPlacementId
    FROM run_inputs i JOIN block_revisions v ON v.id=i.revision_id
    JOIN runs r ON r.id=i.run_id LEFT JOIN run_placements l ON l.run_id=r.id
    WHERE i.kind='source' AND r.owner_id=? AND r.output_block_id IN (
      SELECT block_id FROM placements WHERE brane_id=?
    ) ORDER BY r.created_at,i.position
  `,
    )
    .all(actor, id) as Derivation[];
  return { brane, placements, blocks, runs, derivations };
}
