// What a machine's output becomes on the table. The prompt declares it, as it declares
// the slots: a last line "Output: cards" makes each numbered item of the answer its own
// card, and "Output: diagram" adds the arrows its relation lines name. Without the line
// the answer is one card.
export type MachineOutput = 'card' | 'cards' | 'diagram';
// One answer becomes at most this many cards; items past it stay in the whole answer.
export const MAX_OUTPUT_CARDS = 24;
const declaration = /^\s*output:\s*(cards|diagram)\s*\.?\s*$/im;

export function machineOutput(template: string): MachineOutput {
  const lines = template.trimEnd().split('\n');
  const match = declaration.exec(lines.at(-1) ?? '');
  return match ? (match[1].toLowerCase() as MachineOutput) : 'card';
}

// The prompt with its declaration set to this output: the line replaced, added or
// removed, the rest of the prompt untouched.
export function declareMachineOutput(template: string, output: MachineOutput) {
  const lines = template.trimEnd().split('\n');
  const body = declaration.test(lines.at(-1) ?? '') ? lines.slice(0, -1) : lines;
  const text = body.join('\n').trimEnd();
  return output === 'card' ? text : `${text}\nOutput: ${output}`;
}

export interface OutputArrow {
  // Positions in the item list, from zero.
  from: number;
  to: number;
  label: string;
}
export interface OutputParts {
  items: string[];
  arrows: OutputArrow[];
  // Relation lines that name an item the answer does not have, or join an item to itself.
  dropped: number;
  // How many items the answer listed, those past the card bound included.
  listed: number;
}

const itemLine = /^\s*(\d{1,3})[.)]\s+(.+)$/;
// "2 —supports→ 1", "2 -supports-> 1", "2 – supports → 1"
const arrowLine = /^\s*(\d{1,3})\s*[-–—]+\s*(.{1,60}?)\s*[-–—]*\s*(?:→|->|>)\s*(\d{1,3})\s*\.?\s*$/;

// An answer's numbered items, with their continuation lines, and for a diagram the
// arrows between them. Item numbers are the answer's own; arrows refer to them.
export function parseOutput(text: string, output: MachineOutput): OutputParts {
  const items: { number: number; lines: string[] }[] = [];
  const named: { from: number; to: number; label: string }[] = [];
  let open = false;
  for (const line of text.split('\n')) {
    const arrow = output === 'diagram' ? arrowLine.exec(line) : null;
    if (arrow) {
      named.push({ from: Number(arrow[1]), to: Number(arrow[3]), label: arrow[2].trim() });
      open = false;
      continue;
    }
    const item = itemLine.exec(line);
    if (item) {
      items.push({ number: Number(item[1]), lines: [item[2].trim()] });
      open = true;
    } else if (!line.trim()) open = false;
    else if (open) items.at(-1)!.lines.push(line.trim());
  }
  const kept = items.slice(0, MAX_OUTPUT_CARDS);
  const position = new Map<number, number>();
  kept.forEach((item, index) => {
    if (!position.has(item.number)) position.set(item.number, index);
  });
  const seen = new Set<string>();
  const arrows: OutputArrow[] = [];
  for (const arrow of named) {
    const from = position.get(arrow.from),
      to = position.get(arrow.to);
    const key = `${from}>${to}`;
    if (from === undefined || to === undefined || from === to || seen.has(key) || !arrow.label)
      continue;
    seen.add(key);
    arrows.push({ from, to, label: arrow.label });
  }
  return {
    items: kept.map((item) => item.lines.join('\n')),
    arrows,
    dropped: named.length - arrows.length,
    listed: items.length,
  };
}

// A diagram's layers: each card one layer past the cards with arrows into it, so an
// arrow always points down the page. A cycle has no such layering; then none.
export function diagramLayers(count: number, arrows: OutputArrow[]): number[] | null {
  const layer = Array.from({ length: count }, () => 0);
  for (let round = 0; round <= count; round++) {
    let changed = false;
    for (const arrow of arrows)
      if (layer[arrow.to] < layer[arrow.from] + 1) {
        layer[arrow.to] = layer[arrow.from] + 1;
        changed = true;
      }
    if (!changed) return layer;
  }
  return null;
}

// The groups whose cards are answers cut at the card bound: for each, how many cards
// its answers became and how many items those answers listed.
export function answerCuts(state: {
  parts: { runId: string; blockId: string }[];
  runs: { id: string; output_block_id: string }[];
  blocks: { id: string; content: { text: string } }[];
  placements: { id: string; block_id: string }[];
  groups: { id: string; members: string[] }[];
}): Map<string, { cards: number; listed: number }> {
  const runOf = new Map(state.parts.map((part) => [part.blockId, part.runId]));
  const blockOf = new Map(state.placements.map((p) => [p.id, p.block_id]));
  const cuts = new Map<string, { cards: number; listed: number }>();
  for (const group of state.groups) {
    const runs = new Set(
      group.members.flatMap((member) => {
        const run = runOf.get(blockOf.get(member) ?? '');
        return run ? [run] : [];
      }),
    );
    let cards = 0,
      listed = 0;
    for (const runId of runs) {
      const run = state.runs.find((r) => r.id === runId);
      const text = state.blocks.find((b) => b.id === run?.output_block_id)?.content.text ?? '';
      const parts = state.parts.filter((part) => part.runId === runId).length;
      cards += parts;
      listed += Math.max(parts, parseOutput(text, 'cards').listed);
    }
    if (listed > cards) cuts.set(group.id, { cards, listed });
  }
  return cuts;
}
