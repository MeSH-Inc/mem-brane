import { randomUUID } from 'node:crypto';
import type { DB } from '../db/index.js';
import type {
  BlockKind,
  Content,
  Edit,
  Revision,
  Placement,
  Geometry,
} from '../../shared/types/domain.js';
import { canEditBrane, canReadBrane, DomainError, requireOwned } from '../domain/access.js';
export const uid = () => randomUUID();
export const now = () => Date.now();
export function createBrane(db: DB, actor: string, title = 'Untitled brane') {
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
  return createBlock(db, actor, 'text', { text: '' }, braneId, geometry);
}
export function updateBlockLiveState(db: DB, actor: string, edit: Edit) {
  const block = requireOwned(db, 'blocks', actor, edit.blockId);
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
    snapshotBlock(actor, blockId) {
      const block = requireOwned(db, 'blocks', actor, blockId);
      const live = db
        .prepare('SELECT content_json FROM block_live_state WHERE block_id=?')
        .get(blockId) as any;
      if (!live) {
        const existing = db
          .prepare(
            'SELECT * FROM block_revisions WHERE block_id=? ORDER BY created_at DESC LIMIT 1',
          )
          .get(blockId) as any;
        if (!existing)
          throw new DomainError(409, 'Only finalized responses can be used as context');
        return { ...existing, content: JSON.parse(existing.content_json) };
      }
      const content: Content = JSON.parse(live.content_json);
      if (block.kind === 'webpage' && content.status !== 'ready')
        throw new DomainError(409, 'Webpage is not ready; paste content or wait for import');
      const revision = { id: uid(), block_id: blockId, content, created_at: now() };
      db.prepare('INSERT INTO block_revisions VALUES (?,?,?,?)').run(
        revision.id,
        blockId,
        live.content_json,
        revision.created_at,
      );
      return revision;
    },
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
export function readBrane(db: DB, actor: string, id: string) {
  const brane = canReadBrane(db, actor, id);
  const placements = db
    .prepare('SELECT * FROM placements WHERE brane_id=? ORDER BY z_index,updated_at')
    .all(id);
  const blocks = (
    db
      .prepare(
        `SELECT DISTINCT b.*, l.content_json, l.version FROM blocks b JOIN placements p ON p.block_id=b.id LEFT JOIN block_live_state l ON l.block_id=b.id WHERE p.brane_id=?`,
      )
      .all(id) as any[]
  ).map((b) => {
    const final = db
      .prepare(
        'SELECT r.content_json,o.message_id FROM block_revisions r JOIN run_outputs o ON o.revision_id=r.id WHERE r.block_id=?',
      )
      .get(b.id) as any;
    return {
      id: b.id,
      kind: b.kind,
      origin: b.origin,
      version: b.version ?? 0,
      content: JSON.parse(b.content_json ?? final?.content_json ?? '{"text":""}'),
      messageId: final?.message_id,
    };
  });
  const runs = db
    .prepare(
      "SELECT r.*,COALESCE(c.text,'') partial FROM runs r LEFT JOIN run_checkpoints c ON c.run_id=r.id WHERE r.brane_id=? ORDER BY r.created_at",
    )
    .all(id);
  const derivations = db
    .prepare(
      `
    SELECT i.run_id runId, v.block_id sourceBlockId, i.revision_id sourceRevisionId,
      r.output_block_id outputBlockId, i.position,
      l.anchor_placement_id anchorPlacementId, l.output_placement_id outputPlacementId
    FROM run_inputs i JOIN block_revisions v ON v.id=i.revision_id
    JOIN runs r ON r.id=i.run_id LEFT JOIN run_placements l ON l.run_id=r.id
    WHERE i.kind='source' AND r.owner_id=? AND EXISTS (
      SELECT 1 FROM placements p WHERE p.brane_id=? AND p.block_id=r.output_block_id
    ) ORDER BY r.created_at,i.position
  `,
    )
    .all(actor, id);
  return { brane, placements, blocks, runs, derivations };
}
