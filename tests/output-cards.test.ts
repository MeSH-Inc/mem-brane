import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from '../server/db/index';
import {
  createBrane,
  createTextBlock,
  createMachineBlock,
  updateBlockLiveState,
  revisions,
  readBrane,
  uid,
} from '../server/services/content';
import { runMachine } from '../server/services/runs';
import { completeAttempt, startAttempt } from '../server/services/run-lifecycle';
import { applyWorkspaceOperation } from '../server/services/workspace-operations';
import type { WorkspaceCommand } from '../shared/workspace-commands';
import { machineOutput, parseOutput, MAX_OUTPUT_CARDS } from '../shared/machine-output';
import { BUILT_IN_MACHINES } from '../shared/machines';
import type { BraneState } from '../shared/types/domain';
import { answerStaleness, machineStaleness } from '../src/canvas/machines';
import { columnHeading, matrixLayout, matrixOf } from '../src/canvas/matrix';
import { tableMembers } from '../src/canvas/groups';

describe('the output a prompt declares', () => {
  it('is read from the prompt’s last line', () => {
    const split = BUILT_IN_MACHINES.find((m) => m.name === 'Split')!.template;
    const diagram = BUILT_IN_MACHINES.find((m) => m.name === 'Diagram')!.template;
    expect(machineOutput(split)).toBe('cards');
    expect(machineOutput(diagram)).toBe('diagram');
    expect(machineOutput('Summarise {cards}.')).toBe('card');
    expect(machineOutput('Output: cards\nSummarise {cards}.')).toBe('card');
  });

  it('splits numbered items, keeping their continuation lines', () => {
    const parts = parseOutput(
      'Here are the ideas:\n1. Sleep helps memory.\n   Mostly in deep sleep.\n2) Naps help too.\n\nThat is all.',
      'cards',
    );
    expect(parts.items).toEqual(['Sleep helps memory.\nMostly in deep sleep.', 'Naps help too.']);
    expect(parts.arrows).toEqual([]);
  });

  it('reads a diagram’s arrows by item number and drops those naming no item', () => {
    const parts = parseOutput(
      [
        '1. Claim',
        '2. Evidence',
        '3. Objection',
        '2 —supports→ 1',
        '3 -contradicts-> 1',
        '4 —supports→ 1',
        '1 —restates→ 1',
        '2 – supports → 1',
      ].join('\n'),
      'diagram',
    );
    expect(parts.items).toEqual(['Claim', 'Evidence', 'Objection']);
    expect(parts.arrows).toEqual([
      { from: 1, to: 0, label: 'supports' },
      { from: 2, to: 0, label: 'contradicts' },
    ]);
    expect(parts.dropped).toBe(3);
  });

  it('keeps at most the first cards', () => {
    const text = Array.from({ length: 30 }, (_, i) => `${i + 1}. Idea ${i + 1}`).join('\n');
    expect(parseOutput(text, 'cards').items).toHaveLength(MAX_OUTPUT_CARDS);
  });

  it('heads a matrix column with the prompt’s question', () => {
    expect(
      columnHeading('From {source}, answer in one short sentence: what is its main finding?'),
    ).toBe('What is its main finding?');
    expect(columnHeading('Split {text} into ideas.')).toBe('Split');
  });
});

let db: DB, actor: string, brane: string;
const limits = { models: ['mock'], maxTokens: 200, userConcurrency: 3, maxContextCharacters: 1e5 };
const apply = (command: WorkspaceCommand) =>
  applyWorkspaceOperation(db, actor, { key: uid(), command });
const card = (text: string, x: number, y = 0) => {
  const created = createTextBlock(db, actor, brane, { x, y, width: 260, height: 160 });
  updateBlockLiveState(db, actor, { blockId: created.id, text, version: 0 });
  return created;
};
const machineCard = (template: string, y = 400) =>
  createMachineBlock(db, actor, brane, { x: 0, y, width: 400, height: 300 }, template);
const feed = (
  machinePlacementId: string,
  slot: string,
  from: { placementId?: string; groupId?: string },
) =>
  apply({
    type: 'feed.create',
    id: uid(),
    braneId: brane,
    ...(from.groupId ? { fromGroupId: from.groupId } : { fromPlacementId: from.placementId! }),
    toPlacementId: machinePlacementId,
    slot,
  });
const press = (machinePlacementId: string) => {
  const view = machineStaleness(readBrane(db, actor, brane), machinePlacementId);
  return runMachine(
    db,
    revisions(db),
    actor,
    {
      braneId: brane,
      key: uid(),
      machinePlacementId,
      model: 'mock',
      inputs: view.inputs.map(({ blockId, slot }) => ({ blockId, slot })),
      each: view.eachSlot ?? undefined,
      edits: [],
    },
    limits,
  );
};
// The worker's completion, with the model's answer.
const complete = (runId: string, text: string) => {
  db.prepare("UPDATE runs SET status='claimed',lease_owner='w',lease_until=? WHERE id=?").run(
    Date.now() + 60000,
    runId,
  );
  const token = startAttempt(db, runId, 'w')!;
  expect(completeAttempt(db, token, { text })).toBe(true);
};
const runsOf = (machinePlacementId: string) =>
  db
    .prepare(
      `SELECT r.id FROM runs r JOIN run_placements l ON l.run_id=r.id
       WHERE l.anchor_placement_id=? ORDER BY r.created_at,r.rowid`,
    )
    .all(machinePlacementId)
    .map((row) => (row as { id: string }).id);
const textOf = (state: BraneState, placementId: string) => {
  const placement = state.placements.find((p) => p.id === placementId)!;
  return state.blocks.find((b) => b.id === placement.block_id)!.content.text;
};
const groupOfPlacement = (state: BraneState, placementId: string) =>
  state.groups.find((g) => g.members.includes(placementId));

beforeEach(() => {
  db = openDatabase(':memory:');
  actor = uid();
  db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
    actor,
    'Tester',
    `${actor}@example.com`,
    Date.now(),
    Date.now(),
  );
  brane = createBrane(db, actor).id;
});
afterEach(() => db.close());

const SPLIT = BUILT_IN_MACHINES.find((m) => m.name === 'Split')!.template;
const DIAGRAM = BUILT_IN_MACHINES.find((m) => m.name === 'Diagram')!.template;

it('places a split answer as a stack of cards, the whole answer on the first card’s back', () => {
  const paper = card('Paper', 0);
  const split = machineCard(SPLIT);
  feed(split.placement.id, 'text', { placementId: paper.placement.id });
  const run = press(split.placement.id);
  complete(run.id, '1. First idea.\n2. Second idea.\n3. Third idea.');
  const state = readBrane(db, actor, brane);
  expect(state.parts.map((p) => p.position)).toEqual([0, 1, 2]);
  const placements = state.parts.map((part) =>
    state.placements.find((p) => p.block_id === part.blockId)!,
  );
  expect(placements.map((p) => textOf(state, p.id))).toEqual([
    'First idea.',
    'Second idea.',
    'Third idea.',
  ]);
  const stack = groupOfPlacement(state, placements[0].id)!;
  expect(stack).toMatchObject({ label: 'Split', display: 'stack' });
  expect(stack.members).toEqual(placements.map((p) => p.id));
  // The whole answer is on the first card's back; the run is still the producer.
  const whole = state.placements.find((p) => p.block_id === run.output_block_id)!;
  expect(whole.host_placement_id).toBe(placements[0].id);
  expect(state.runs.map((r) => r.id)).toContain(run.id);
  // Each card is derived from what the run was sent, so an edit to it is staleness.
  for (const part of state.parts)
    expect(state.derivations.filter((d) => d.outputBlockId === part.blockId)).toMatchObject([
      { runId: run.id, sourceBlockId: paper.id, label: 'text' },
    ]);
  expect(answerStaleness(state, state.parts[1].blockId).stale).toBe(false);
  updateBlockLiveState(db, actor, { blockId: paper.id, text: 'Paper, revised', version: 1 });
  expect(answerStaleness(readBrane(db, actor, brane), state.parts[1].blockId).stale).toBe(true);
});

it('keeps an answer of fewer than two items as one card', () => {
  const paper = card('Paper', 0);
  const split = machineCard(SPLIT);
  feed(split.placement.id, 'text', { placementId: paper.placement.id });
  const run = press(split.placement.id);
  complete(run.id, 'There is only one idea here.');
  const state = readBrane(db, actor, brane);
  expect(state.parts).toEqual([]);
  expect(state.placements.find((p) => p.block_id === run.output_block_id)!.host_placement_id).toBe(
    null,
  );
  expect(state.groups).toEqual([]);
});

it('places a diagram as a region of cards with its arrows drawn', () => {
  const paper = card('Paper', 0);
  const diagram = machineCard(DIAGRAM);
  feed(diagram.placement.id, 'material', { placementId: paper.placement.id });
  const run = press(diagram.placement.id);
  complete(
    run.id,
    '1. Claim\n2. Evidence\n3. Doubt\n\n2 —supports→ 1\n3 —questions→ 2\n9 —supports→ 1',
  );
  const state = readBrane(db, actor, brane);
  const [claim, evidence, doubt] = state.parts.map((part) =>
    state.placements.find((p) => p.block_id === part.blockId)!,
  );
  expect(groupOfPlacement(state, claim.id)).toMatchObject({ label: 'Diagram', display: 'region' });
  // Laid on a grid: no two cards share a place.
  expect(new Set([claim, evidence, doubt].map((p) => `${p.x},${p.y}`)).size).toBe(3);
  expect(
    state.relations.map((r) => [r.from_placement_id, r.label, r.to_placement_id]).sort(),
  ).toEqual(
    [
      [evidence.id, 'supports', claim.id],
      [doubt.id, 'questions', evidence.id],
    ].sort(),
  );
});

it('puts each answer’s cards in its place in the stack a press made', () => {
  const papers = [1, 2].map((n) => card(`Paper ${n}`, n * 300));
  const groupId = uid();
  apply({
    type: 'group.create',
    id: groupId,
    braneId: brane,
    label: 'Papers',
    display: 'stack',
    members: papers.map((p) => p.placement.id),
  });
  const split = machineCard(SPLIT);
  feed(split.placement.id, 'text', { groupId });
  const feedId = readBrane(db, actor, brane).feeds[0].id;
  apply({ type: 'feed.mode', id: feedId, braneId: brane, mode: 'each' });
  press(split.placement.id);
  const [first, second] = runsOf(split.placement.id);
  // The second paper's answer arrives first; each takes its own place in the stack.
  complete(second, '1. B one.\n2. B two.');
  complete(first, '1. A one.\n2. A two.\n3. A three.');
  const state = readBrane(db, actor, brane);
  const stack = state.groups.find((g) => g.label === 'Each text')!;
  expect(stack.members.map((id) => textOf(state, id))).toEqual([
    'A one.',
    'A two.',
    'A three.',
    'B one.',
    'B two.',
  ]);
  expect(state.groups.filter((g) => g.label === 'Split')).toEqual([]);
});

it('reruns a split in place: the old cards go on the new answer’s back', () => {
  const paper = card('Paper', 0);
  const split = machineCard(SPLIT);
  feed(split.placement.id, 'text', { placementId: paper.placement.id });
  complete(press(split.placement.id).id, '1. Old one.\n2. Old two.');
  const before = readBrane(db, actor, brane);
  const oldCards = before.parts.map(
    (part) => before.placements.find((p) => p.block_id === part.blockId)!.id,
  );
  updateBlockLiveState(db, actor, { blockId: paper.id, text: 'Paper, revised', version: 1 });
  const rerun = press(split.placement.id);
  let state = readBrane(db, actor, brane);
  // While it runs, one card holds the tray's place and the old ones are on its back.
  const answer = state.placements.find((p) => p.block_id === rerun.output_block_id)!;
  expect(answer.host_placement_id).toBe(null);
  expect(
    oldCards.map((id) => state.placements.find((p) => p.id === id)!.host_placement_id),
  ).toEqual([answer.id, answer.id]);
  expect(state.groups).toEqual([]);
  complete(rerun.id, '1. New one.\n2. New two.\n3. New three.');
  state = readBrane(db, actor, brane);
  const newCards = state.parts
    .filter((p) => p.runId === rerun.id)
    .map((part) => state.placements.find((p) => p.block_id === part.blockId)!);
  expect(newCards.map((p) => p.host_placement_id)).toEqual([null, null, null]);
  // Backs are one level deep: everything earlier is on the first new card's back.
  for (const id of [...oldCards, answer.id])
    expect(state.placements.find((p) => p.id === id)!.host_placement_id).toBe(newCards[0].id);
  expect(groupOfPlacement(state, newCards[0].id)!.members).toEqual(newCards.map((p) => p.id));
});

describe('a matrix', () => {
  let papers: ReturnType<typeof card>[];
  let machines: ReturnType<typeof machineCard>[];
  let stackId: string;
  const questions = ['what is its method?', 'what is its sample size?'];
  beforeEach(() => {
    papers = [1, 2, 3].map((n) => card(`Paper ${n}`, n * 300));
    stackId = uid();
    apply({
      type: 'group.create',
      id: stackId,
      braneId: brane,
      label: 'Papers',
      display: 'stack',
      members: papers.map((p) => p.placement.id),
    });
    machines = questions.map((question, index) =>
      machineCard(`From {source}, answer in one short sentence: ${question}`, 400 + index * 400),
    );
    for (const machine of machines) {
      feed(machine.placement.id, 'source', { groupId: stackId });
      const feedId = readBrane(db, actor, brane).feeds.find(
        (f) => f.to_placement_id === machine.placement.id,
      )!.id;
      apply({ type: 'feed.mode', id: feedId, braneId: brane, mode: 'each' });
      press(machine.placement.id);
      runsOf(machine.placement.id).forEach((run, index) => complete(run, `Answer ${index + 1}`));
    }
  });
  // The two output stacks merged into one group, as G merges selected groups.
  const merge = () => {
    const state = readBrane(db, actor, brane);
    const [first, second] = state.groups.filter((g) => g.id !== stackId);
    apply({ type: 'group.remove', id: second.id, braneId: brane });
    apply({
      type: 'group.edit',
      id: first.id,
      braneId: brane,
      label: first.label,
      display: 'matrix',
      members: [...first.members, ...second.members],
    });
    return first.id;
  };

  it('has a row per paper and a column per machine', () => {
    const groupId = merge();
    const state = readBrane(db, actor, brane);
    const group = state.groups.find((g) => g.id === groupId)!;
    const matrix = matrixOf(state, group)!;
    expect(matrix.rows.map((r) => r.label)).toEqual(['Paper 1', 'Paper 2', 'Paper 3']);
    expect(matrix.columns.map((c) => c.label)).toEqual([
      'What is its method?',
      'What is its sample size?',
    ]);
    const members = tableMembers(state, group);
    const layout = matrixLayout(members, matrix);
    // Same row, same height; same column, same left edge.
    const cell = (row: number, column: number) =>
      layout[
        members.findIndex(
          (m) => matrix.cells.get(m.id)!.row === row && matrix.cells.get(m.id)!.column === column,
        )
      ];
    expect(cell(1, 0).y).toBe(cell(1, 1).y);
    expect(cell(0, 1).x).toBe(cell(2, 1).x);
    expect(cell(0, 1).x).toBeGreaterThan(cell(0, 0).x);
    expect(cell(2, 0).y).toBeGreaterThan(cell(1, 0).y);
    // A stack of the papers themselves is no matrix.
    expect(
      matrixOf(
        state,
        state.groups.find((g) => g.id === stackId)!,
      ),
    ).toBe(null);
  });

  it('is shared: a machine’s rerun replaces only its own column', () => {
    const groupId = merge();
    const before = readBrane(db, actor, brane).groups.find((g) => g.id === groupId)!.members;
    press(machines[0].placement.id);
    const state = readBrane(db, actor, brane);
    const group = state.groups.find((g) => g.id === groupId)!;
    expect(group.members).toHaveLength(6);
    // The first machine's three cells hold new outputs; the second machine's are untouched.
    expect(group.members.slice(3)).toEqual(before.slice(3));
    expect(group.members.slice(0, 3).every((id, index) => id !== before[index])).toBe(true);
    expect(state.groups).toHaveLength(2);
  });
});
