import type { BraneState, Geometry, Group } from '../../shared/types/domain';

// The frame drawn around a group: padding round its cards, and a header strip above
// them that holds its label, its count and its port.
export const GROUP_PADDING = 18;
export const GROUP_HEADER = 34;
// A stack shows this many edges behind its top card; further cards lie behind those.
export const STACK_EDGES = 3;
const STACK_OFFSET = 10;
const REGION_GAP = 40;

// Rows from top to bottom, and left to right within a row. A card belongs to the row
// whose first card it overlaps by more than half its own height.
export function readingOrder<T extends Geometry>(placements: T[]): T[] {
  const rows: T[][] = [];
  for (const placement of [...placements].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.at(-1);
    if (row && placement.y < row[0].y + row[0].height / 2) row.push(placement);
    else rows.push([placement]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x));
}

export function bounds(placements: Geometry[]): Geometry {
  const left = Math.min(...placements.map((p) => p.x));
  const top = Math.min(...placements.map((p) => p.y));
  const right = Math.max(...placements.map((p) => p.x + p.width));
  const bottom = Math.max(...placements.map((p) => p.y + p.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function frame(placements: Geometry[]): Geometry {
  const b = bounds(placements);
  return {
    x: b.x - GROUP_PADDING,
    y: b.y - GROUP_PADDING - GROUP_HEADER,
    width: b.width + GROUP_PADDING * 2,
    height: b.height + GROUP_PADDING * 2 + GROUP_HEADER,
  };
}

// A stack piles its members into the first member's space, each the first member's
// size, the first on top.
export function stackLayout(members: Geometry[]): Geometry[] {
  const [top] = members;
  return members.map((_, index) => {
    const offset = Math.min(index, STACK_EDGES) * STACK_OFFSET;
    return { x: top.x + offset, y: top.y + offset, width: top.width, height: top.height };
  });
}

// A region spread from a stack lays its members on a grid in member order, from the
// stack's corner.
export function regionLayout(members: Geometry[]): Geometry[] {
  const [first] = members;
  const columns = Math.ceil(Math.sqrt(members.length));
  const width = Math.max(...members.map((m) => m.width));
  const height = Math.max(...members.map((m) => m.height));
  return members.map((member, index) => ({
    x: first.x + (index % columns) * (width + REGION_GAP),
    y: first.y + Math.floor(index / columns) * (height + REGION_GAP),
    width: member.width,
    height: member.height,
  }));
}

export function groupOf(groups: Group[], placementId: string) {
  return groups.find((g) => g.members.includes(placementId));
}

// The members still on the table, in member order.
export function tableMembers(state: Pick<BraneState, 'placements'>, group: Group) {
  const placed = new Map(
    state.placements.filter((p) => !p.host_placement_id).map((p) => [p.id, p]),
  );
  return group.members.flatMap((id) => (placed.has(id) ? [placed.get(id)!] : []));
}

// "Group 3" for the third group, or the next free number.
export function nextGroupLabel(groups: Group[]) {
  const used = new Set(groups.map((g) => g.label));
  let n = groups.length + 1;
  while (used.has(`Group ${n}`)) n++;
  return `Group ${n}`;
}
