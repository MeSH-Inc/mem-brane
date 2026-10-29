import type { DB } from '../db/index.js';
import type { Feed } from '../../shared/types/domain.js';
import { canEditBrane, canReadBrane, DomainError } from '../domain/access.js';

export const MAX_BRANE_FEEDS = 400;

export interface FeedRequest {
  id: string;
  braneId: string;
  fromPlacementId: string;
  toPlacementId: string;
  slot: string;
}

// A feed records which card fills which machine slot. It names a slot without
// requiring the machine's current template to contain it: templates change, and a
// run validates its inputs against the template revision it freezes.
export function createFeed(db: DB, actor: string, input: FeedRequest): Feed {
  canEditBrane(db, actor, input.braneId);
  const endpoints = db
    .prepare<unknown[], { id: string; brane_id: string; kind: string }>(
      `SELECT p.id,p.brane_id,b.kind FROM placements p JOIN blocks b ON b.id=p.block_id
       WHERE p.id IN (?,?)`,
    )
    .all(input.fromPlacementId, input.toPlacementId);
  const source = endpoints.find((p) => p.id === input.fromPlacementId);
  const target = endpoints.find((p) => p.id === input.toPlacementId);
  if (!source || !target || source.brane_id !== input.braneId || target.brane_id !== input.braneId)
    throw new DomainError(400, 'Both ends of a feed must be placed on this brane.');
  if (target.kind !== 'machine') throw new DomainError(400, 'A feed must end on a machine.');
  if (source.kind === 'machine') throw new DomainError(400, 'A machine cannot feed a machine.');
  if (
    db
      .prepare('SELECT 1 FROM feeds WHERE from_placement_id=? AND to_placement_id=? AND slot=?')
      .get(input.fromPlacementId, input.toPlacementId, input.slot)
  )
    throw new DomainError(409, 'This card already feeds that slot.');
  if (
    (
      db.prepare('SELECT count(*) n FROM feeds WHERE brane_id=?').get(input.braneId) as {
        n: number;
      }
    ).n >= MAX_BRANE_FEEDS
  )
    throw new DomainError(429, 'Brane feed capacity reached', 'quota');
  const feed: Feed = {
    id: input.id,
    brane_id: input.braneId,
    from_placement_id: input.fromPlacementId,
    to_placement_id: input.toPlacementId,
    slot: input.slot,
    created_at: Date.now(),
  };
  db.prepare('INSERT INTO feeds VALUES (?,?,?,?,?,?)').run(
    feed.id,
    feed.brane_id,
    feed.from_placement_id,
    feed.to_placement_id,
    feed.slot,
    feed.created_at,
  );
  return feed;
}

// Removing a feed that a placement removal already cascaded away satisfies the intent.
export function removeFeed(db: DB, actor: string, id: string, braneId: string) {
  canEditBrane(db, actor, braneId);
  db.prepare('DELETE FROM feeds WHERE id=? AND brane_id=?').run(id, braneId);
}

export function readFeeds(db: DB, actor: string, braneId: string): Feed[] {
  canReadBrane(db, actor, braneId);
  return db
    .prepare<unknown[], Feed>('SELECT * FROM feeds WHERE brane_id=? ORDER BY created_at,id')
    .all(braneId);
}
