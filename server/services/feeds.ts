import type { DB } from '../db/index.js';
import type { Feed } from '../../shared/types/domain.js';
import { canEditBrane, canReadBrane, DomainError } from '../domain/access.js';
import { closesLoop, LOOP_REFUSAL, type MachineEdge } from '../../shared/machines.js';

export const MAX_BRANE_FEEDS = 400;

export interface FeedRequest {
  id: string;
  braneId: string;
  // Exactly one source: a card, or a group whose members feed in member order.
  fromPlacementId?: string;
  fromGroupId?: string;
  toPlacementId: string;
  slot: string;
}

// A feed records which card, or which group of cards, fills which machine slot. It
// names a slot without requiring the machine's current template to contain it:
// templates change, and a run validates its inputs against the template revision it
// freezes.
export function createFeed(db: DB, actor: string, input: FeedRequest): Feed {
  canEditBrane(db, actor, input.braneId);
  if (!input.fromPlacementId === !input.fromGroupId)
    throw new DomainError(400, 'A feed comes from one card or one group.');
  const target = db
    .prepare<unknown[], { brane_id: string; kind: string }>(
      'SELECT p.brane_id,b.kind FROM placements p JOIN blocks b ON b.id=p.block_id WHERE p.id=?',
    )
    .get(input.toPlacementId);
  if (!target || target.brane_id !== input.braneId)
    throw new DomainError(400, 'Both ends of a feed must be placed on this brane.');
  if (target.kind !== 'machine') throw new DomainError(400, 'A feed must end on a machine.');
  if (input.fromPlacementId) {
    const source = db
      .prepare<unknown[], { brane_id: string; kind: string }>(
        'SELECT p.brane_id,b.kind FROM placements p JOIN blocks b ON b.id=p.block_id WHERE p.id=?',
      )
      .get(input.fromPlacementId);
    if (!source || source.brane_id !== input.braneId)
      throw new DomainError(400, 'Both ends of a feed must be placed on this brane.');
    if (source.kind === 'machine') throw new DomainError(400, 'A machine cannot feed a machine.');
  } else if (
    !db
      .prepare('SELECT 1 FROM groups WHERE id=? AND brane_id=?')
      .get(input.fromGroupId, input.braneId)
  )
    throw new DomainError(400, 'This group is no longer on the brane.');
  if (
    db
      .prepare(
        `SELECT 1 FROM feeds WHERE to_placement_id=? AND slot=?
         AND (from_placement_id=? OR from_group_id=?)`,
      )
      .get(
        input.toPlacementId,
        input.slot,
        input.fromPlacementId ?? null,
        input.fromGroupId ?? null,
      )
  )
    throw new DomainError(
      409,
      input.fromGroupId
        ? 'This group already feeds that slot.'
        : 'This card already feeds that slot.',
    );
  const producers = sourceProducers(db, input);
  if (closesLoop(machineEdges(db, input.braneId), producers, input.toPlacementId))
    throw new DomainError(
      409,
      'This feed would close a loop: the machine would feed its own input.',
    );
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
    from_placement_id: input.fromPlacementId ?? null,
    from_group_id: input.fromGroupId ?? null,
    to_placement_id: input.toPlacementId,
    slot: input.slot,
    mode: 'together',
    created_at: Date.now(),
  };
  db.prepare(
    'INSERT INTO feeds (id,brane_id,from_placement_id,from_group_id,to_placement_id,slot,created_at) VALUES (?,?,?,?,?,?,?)',
  ).run(
    feed.id,
    feed.brane_id,
    feed.from_placement_id,
    feed.from_group_id,
    feed.to_placement_id,
    feed.slot,
    feed.created_at,
  );
  return feed;
}

// The machines that produced a placement: its run's anchor, for an answer or a card an
// answer was split into.
const PRODUCERS = `SELECT DISTINCT l.anchor_placement_id FROM placements p
  JOIN runs r ON r.output_block_id=p.block_id
    OR r.id IN (SELECT run_id FROM run_parts WHERE block_id=p.block_id)
  JOIN run_placements l ON l.run_id=r.id
  JOIN placements m ON m.id=l.anchor_placement_id JOIN blocks mb ON mb.id=m.block_id
  WHERE mb.kind='machine' AND p.id`;
function sourceProducers(db: DB, input: Pick<FeedRequest, 'fromPlacementId' | 'fromGroupId'>) {
  return (
    input.fromPlacementId
      ? db.prepare(`${PRODUCERS}=?`).pluck().all(input.fromPlacementId)
      : db
          .prepare(`${PRODUCERS} IN (SELECT placement_id FROM group_members WHERE group_id=?)`)
          .pluck()
          .all(input.fromGroupId)
  ) as string[];
}
// Every machine-to-machine edge the brane's feeds make.
function machineEdges(db: DB, braneId: string): MachineEdge[] {
  const feeds = db
    .prepare<
      unknown[],
      { from_placement_id: string | null; from_group_id: string | null; to_placement_id: string }
    >('SELECT from_placement_id,from_group_id,to_placement_id FROM feeds WHERE brane_id=?')
    .all(braneId);
  return feeds.flatMap((feed) =>
    sourceProducers(db, {
      fromPlacementId: feed.from_placement_id ?? undefined,
      fromGroupId: feed.from_group_id ?? undefined,
    }).map((producer) => ({ producer, consumer: feed.to_placement_id })),
  );
}

// A group feed runs its machine with all its cards at once, or once per card. Only one
// slot of a machine runs each, so one press fans out over one list of cards.
export function setFeedMode(
  db: DB,
  actor: string,
  id: string,
  braneId: string,
  mode: Feed['mode'],
) {
  canEditBrane(db, actor, braneId);
  const feed = db
    .prepare<unknown[], Feed>('SELECT * FROM feeds WHERE id=? AND brane_id=?')
    .get(id, braneId);
  if (!feed) throw new DomainError(404, 'This feed is no longer on the brane.');
  if (mode === 'each' && !feed.from_group_id)
    throw new DomainError(400, 'Only a group can feed a slot one card at a time.');
  if (
    mode === 'each' &&
    db
      .prepare("SELECT 1 FROM feeds WHERE to_placement_id=? AND slot<>? AND mode='each'")
      .get(feed.to_placement_id, feed.slot)
  )
    throw new DomainError(409, 'Another slot of this machine already runs each.');
  db.prepare('UPDATE feeds SET mode=? WHERE id=?').run(mode, id);
}

// Removing a feed that a placement removal already cascaded away satisfies the intent.
export function removeFeed(db: DB, actor: string, id: string, braneId: string) {
  canEditBrane(db, actor, braneId);
  db.prepare('DELETE FROM feeds WHERE id=? AND brane_id=?').run(id, braneId);
}

export function readFeeds(db: DB, actor: string, braneId: string): Feed[] {
  canReadBrane(db, actor, braneId);
  return db
    .prepare<unknown[], Feed>(
      'SELECT id,brane_id,from_placement_id,from_group_id,to_placement_id,slot,mode,created_at FROM feeds WHERE brane_id=? ORDER BY rowid',
    )
    .all(braneId);
}
