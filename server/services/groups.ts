import type { DB } from '../db/index.js';
import type { Group } from '../../shared/types/domain.js';
import { canEditBrane, canReadBrane, DomainError } from '../domain/access.js';

export const MAX_BRANE_GROUPS = 100;

export interface GroupRequest {
  id: string;
  braneId: string;
  label: string;
  display: Group['display'];
  members: string[];
}

// A group gathers cards on the table so they move and feed as one. Grouping runs
// nothing; a feed from the group sends its members, in member order, when a run is
// pressed.
export function createGroup(db: DB, actor: string, input: GroupRequest): Group {
  canEditBrane(db, actor, input.braneId);
  if (
    (
      db.prepare('SELECT count(*) n FROM groups WHERE brane_id=?').get(input.braneId) as {
        n: number;
      }
    ).n >= MAX_BRANE_GROUPS
  )
    throw new DomainError(429, 'Brane group capacity reached', 'quota');
  const created_at = Date.now();
  db.prepare('INSERT INTO groups VALUES (?,?,?,?,?)').run(
    input.id,
    input.braneId,
    input.label,
    input.display,
    created_at,
  );
  writeMembers(db, input);
  return { ...groupRow(input), created_at };
}

// Replace the group's label, display and members. Members are written before the old
// ones are removed, so the group is never empty while it changes.
export function editGroup(db: DB, actor: string, input: GroupRequest): Group {
  canEditBrane(db, actor, input.braneId);
  const existing = db
    .prepare<unknown[], { created_at: number }>(
      'SELECT created_at FROM groups WHERE id=? AND brane_id=?',
    )
    .get(input.id, input.braneId);
  if (!existing) throw new DomainError(404, 'This group is no longer on the brane.');
  db.prepare('UPDATE groups SET label=?,display=? WHERE id=?').run(
    input.label,
    input.display,
    input.id,
  );
  writeMembers(db, input);
  return { ...groupRow(input), created_at: existing.created_at };
}

// Removing a group that its last member's removal already took satisfies the intent.
export function removeGroup(db: DB, actor: string, id: string, braneId: string) {
  canEditBrane(db, actor, braneId);
  db.prepare('DELETE FROM groups WHERE id=? AND brane_id=?').run(id, braneId);
}

export function readGroups(db: DB, actor: string, braneId: string): Group[] {
  canReadBrane(db, actor, braneId);
  const groups = db
    .prepare<unknown[], Omit<Group, 'members'>>(
      'SELECT id,brane_id,label,display,created_at FROM groups WHERE brane_id=? ORDER BY rowid',
    )
    .all(braneId);
  const members = db
    .prepare<unknown[], { group_id: string; placement_id: string }>(
      `SELECT m.group_id,m.placement_id FROM group_members m JOIN groups g ON g.id=m.group_id
       WHERE g.brane_id=? ORDER BY m.position`,
    )
    .all(braneId);
  return groups.map((group) => ({
    ...group,
    members: members.filter((m) => m.group_id === group.id).map((m) => m.placement_id),
  }));
}

function groupRow(input: GroupRequest): Omit<Group, 'created_at'> {
  return {
    id: input.id,
    brane_id: input.braneId,
    label: input.label,
    display: input.display,
    members: [...input.members],
  };
}

function writeMembers(db: DB, input: GroupRequest) {
  const rows = db
    .prepare<
      unknown[],
      {
        id: string;
        brane_id: string;
        host_placement_id: string | null;
        kind: string;
        group_id: string | null;
      }
    >(
      `SELECT p.id,p.brane_id,p.host_placement_id,b.kind,m.group_id FROM placements p
       JOIN blocks b ON b.id=p.block_id LEFT JOIN group_members m ON m.placement_id=p.id
       WHERE p.id IN (${input.members.map(() => '?').join(',')})`,
    )
    .all(...input.members);
  if (
    rows.length !== input.members.length ||
    rows.some((p) => p.brane_id !== input.braneId || p.host_placement_id !== null)
  )
    throw new DomainError(
      400,
      'Every member of a group must be a card on the table of this brane.',
    );
  if (rows.some((p) => p.kind === 'machine'))
    throw new DomainError(400, 'Groups hold cards; a machine takes its inputs through slots.');
  if (rows.some((p) => p.group_id !== null && p.group_id !== input.id))
    throw new DomainError(409, 'A card belongs to one group. Take it out of its group first.');
  const write = db.prepare(
    `INSERT INTO group_members VALUES (?,?,?)
     ON CONFLICT(group_id,placement_id) DO UPDATE SET position=excluded.position`,
  );
  input.members.forEach((placementId, position) => write.run(input.id, placementId, position));
  db.prepare(
    `DELETE FROM group_members WHERE group_id=? AND placement_id NOT IN (${input.members.map(() => '?').join(',')})`,
  ).run(input.id, ...input.members);
}
