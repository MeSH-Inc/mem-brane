import type { DB } from '../db/index.js';
import type { Relation } from '../../shared/types/domain.js';
import { canEditBrane, canReadBrane, DomainError } from '../domain/access.js';

export const MAX_BRANE_RELATIONS = 400;

export interface RelationRequest {
  id: string;
  braneId: string;
  fromPlacementId: string;
  toPlacementId: string;
  label: string;
}

// A relation records how one card on the table stands to another. It runs nothing; a
// run whose inputs include both ends sends it as a frozen relation entry.
export function createRelation(db: DB, actor: string, input: RelationRequest): Relation {
  canEditBrane(db, actor, input.braneId);
  if (input.fromPlacementId === input.toPlacementId)
    throw new DomainError(400, 'An arrow joins two different cards.');
  const endpoints = db
    .prepare<
      unknown[],
      { id: string; brane_id: string; host_placement_id: string | null; kind: string }
    >(
      'SELECT p.id,p.brane_id,p.host_placement_id,b.kind FROM placements p JOIN blocks b ON b.id=p.block_id WHERE p.id IN (?,?)',
    )
    .all(input.fromPlacementId, input.toPlacementId);
  if (
    endpoints.length !== 2 ||
    endpoints.some((p) => p.brane_id !== input.braneId || p.host_placement_id !== null)
  )
    throw new DomainError(400, 'Both ends of an arrow must be on the table of this brane.');
  if (endpoints.some((p) => p.kind === 'machine'))
    throw new DomainError(400, 'Arrows join cards; a machine takes its inputs through slots.');
  if (
    db
      .prepare('SELECT 1 FROM relations WHERE from_placement_id=? AND to_placement_id=?')
      .get(input.fromPlacementId, input.toPlacementId)
  )
    throw new DomainError(409, 'An arrow already joins these cards.');
  if (
    (
      db.prepare('SELECT count(*) n FROM relations WHERE brane_id=?').get(input.braneId) as {
        n: number;
      }
    ).n >= MAX_BRANE_RELATIONS
  )
    throw new DomainError(429, 'Brane arrow capacity reached', 'quota');
  const relation: Relation = {
    id: input.id,
    brane_id: input.braneId,
    from_placement_id: input.fromPlacementId,
    to_placement_id: input.toPlacementId,
    label: input.label,
    created_at: Date.now(),
  };
  db.prepare('INSERT INTO relations VALUES (?,?,?,?,?,?)').run(
    relation.id,
    relation.brane_id,
    relation.from_placement_id,
    relation.to_placement_id,
    relation.label,
    relation.created_at,
  );
  return relation;
}

// Removing a relation that a placement removal already cascaded away satisfies the intent.
export function removeRelation(db: DB, actor: string, id: string, braneId: string) {
  canEditBrane(db, actor, braneId);
  db.prepare('DELETE FROM relations WHERE id=? AND brane_id=?').run(id, braneId);
}

export function readRelations(db: DB, actor: string, braneId: string): Relation[] {
  canReadBrane(db, actor, braneId);
  return db
    .prepare<unknown[], Relation>(
      'SELECT id,brane_id,from_placement_id,to_placement_id,label,created_at FROM relations WHERE brane_id=? ORDER BY rowid',
    )
    .all(braneId);
}
