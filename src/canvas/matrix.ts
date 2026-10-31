import type { BraneState, Geometry, Group, Placement } from '../../shared/types/domain';
import { machineName } from '../../shared/machines';
import { runsByOutput } from '../services/workspace-document';
import { bounds } from './groups';

// A matrix sets the outputs of machines run each over one stack in a table: a row per
// card they ran over, a column per machine, each cell the output that machine gave for
// that card. Room is left above for the column headings and to the left for the rows'.
export const MATRIX_ROW_HEADER = 170;
export const MATRIX_COLUMN_HEADER = 44;
const MATRIX_GAP = 24;

export interface Matrix {
  rows: { blockId: string; label: string }[];
  columns: { machineBlockId: string; label: string }[];
  // Each member placement's cell.
  cells: Map<string, { row: number; column: number }>;
}

type MatrixState = Pick<BraneState, 'blocks' | 'placements' | 'runs' | 'parts' | 'derivations'>;

// The column heading: the prompt's last question ("what is its main finding?"), else
// the machine's name.
export function columnHeading(template: string) {
  const questions = template.match(/[^.!?:\n{}]*\?/g);
  const question = questions?.at(-1)?.trim();
  if (question) return question.charAt(0).toUpperCase() + question.slice(1);
  return machineName(template);
}

// The first words of a card, as a row heading.
function rowHeading(text: string) {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 60 ? `${line.slice(0, 59)}…` : line || 'Untitled';
}

// A group's matrix, when every member on the table is the output of a machine run each
// (or its split cards) and no two members fall in one cell for different reasons than
// splitting; otherwise none.
export function matrixOf(state: MatrixState, group: Group): Matrix | null {
  const placed = new Map(
    state.placements.filter((p) => !p.host_placement_id).map((p) => [p.id, p]),
  );
  const members = group.members.flatMap((id) => (placed.has(id) ? [placed.get(id)!] : []));
  if (members.length < 2) return null;
  const producer = runsByOutput(state);
  const blocks = new Map(state.blocks.map((b) => [b.id, b]));
  const sourcesOf = (runId: string) => [
    ...new Set(state.derivations.filter((d) => d.runId === runId).map((d) => d.sourceBlockId)),
  ];
  const rows: Matrix['rows'] = [];
  const columns: Matrix['columns'] = [];
  const cells = new Map<string, { row: number; column: number }>();
  for (const member of members) {
    const run = producer[member.block_id];
    if (!run?.machine_block_id || !run.batch_id) return null;
    // The card a run of a batch ran over is the source no other run of its batch sent.
    const mates = state.runs.filter((r) => r.batch_id === run.batch_id && r.id !== run.id);
    const shared = new Set(mates.flatMap((r) => sourcesOf(r.id)));
    const own = sourcesOf(run.id);
    const source = own.find((id) => !shared.has(id)) ?? own[0];
    if (!source) return null;
    let row = rows.findIndex((r) => r.blockId === source);
    if (row < 0)
      row =
        rows.push({ blockId: source, label: rowHeading(blocks.get(source)?.content.text ?? '') }) -
        1;
    let column = columns.findIndex((c) => c.machineBlockId === run.machine_block_id);
    if (column < 0) {
      const machine = blocks.get(run.machine_block_id);
      column =
        columns.push({
          machineBlockId: run.machine_block_id,
          label: machine ? columnHeading(machine.content.text) : 'Machine',
        }) - 1;
    }
    cells.set(member.id, { row, column });
  }
  if (rows.length < 1 || columns.length < 1 || (rows.length < 2 && columns.length < 2)) return null;
  return { rows, columns, cells };
}

// The space a matrix of these members takes, headings included.
export function matrixFootprint(members: Placement[], matrix: Matrix) {
  const width = Math.max(...members.map((m) => m.width));
  const height = Math.max(...members.map((m) => m.height));
  return {
    width: MATRIX_ROW_HEADER + matrix.columns.length * (width + MATRIX_GAP),
    height: MATRIX_COLUMN_HEADER + matrix.rows.length * (height + MATRIX_GAP),
  };
}

// Each member in its cell, from the given corner (by default the members' top left).
// Cards that share a cell (an answer split into cards) pile there as a stack does.
export function matrixLayout(
  members: Placement[],
  matrix: Matrix,
  corner: { x: number; y: number } = bounds(members),
): Geometry[] {
  const width = Math.max(...members.map((m) => m.width));
  const height = Math.max(...members.map((m) => m.height));
  const filled = new Map<string, number>();
  return members.map((member) => {
    const cell = matrix.cells.get(member.id) ?? { row: 0, column: 0 };
    const key = `${cell.row}:${cell.column}`;
    const depth = filled.get(key) ?? 0;
    filled.set(key, depth + 1);
    const offset = Math.min(depth, 3) * 10;
    return {
      x: corner.x + MATRIX_ROW_HEADER + cell.column * (width + MATRIX_GAP) + offset,
      y: corner.y + MATRIX_COLUMN_HEADER + cell.row * (height + MATRIX_GAP) + offset,
      width: member.width,
      height: member.height,
    };
  });
}
