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
import { keepOutput, runMachine } from '../server/services/runs';
import { readInputs } from '../server/services/context-reader';
import { applyWorkspaceOperation } from '../server/services/workspace-operations';
import { declareMachineOutput, diagramLayers, machineOutput } from '../shared/machine-output';
import { machineStaleness } from '../src/canvas/machines';

describe('the output declaration', () => {
  it('is replaced, added or removed without touching the rest of the prompt', () => {
    const prompt = 'Split {text} into ideas.';
    const cards = declareMachineOutput(prompt, 'cards');
    expect(cards).toBe('Split {text} into ideas.\nOutput: cards');
    expect(machineOutput(cards)).toBe('cards');
    expect(declareMachineOutput(cards, 'diagram')).toBe(
      'Split {text} into ideas.\nOutput: diagram',
    );
    expect(declareMachineOutput(cards, 'card')).toBe(prompt);
    expect(declareMachineOutput(prompt, 'card')).toBe(prompt);
  });
});

describe('a diagram’s layers', () => {
  it('put each card one layer past the cards with arrows into it', () => {
    // 2 supports 1, 3 supports 1, 4 questions 3.
    expect(
      diagramLayers(4, [
        { from: 1, to: 0, label: 'supports' },
        { from: 2, to: 0, label: 'supports' },
        { from: 3, to: 2, label: 'questions' },
      ]),
    ).toEqual([2, 0, 1, 0]);
  });
  it('have none when the arrows go round', () => {
    expect(
      diagramLayers(2, [
        { from: 0, to: 1, label: 'causes' },
        { from: 1, to: 0, label: 'causes' },
      ]),
    ).toBe(null);
  });
});

let db: DB, actor: string, brane: string;
let machine: ReturnType<typeof createMachineBlock>;
let paper: ReturnType<typeof createTextBlock>;
const limits = {
  models: ['mock', 'mock-brief'],
  maxTokens: 200,
  userConcurrency: 3,
  maxContextCharacters: 1e5,
};
const finish = () => db.prepare("UPDATE runs SET status='completed'").run();
const press = (models?: string[]) => {
  const view = machineStaleness(readBrane(db, actor, brane), machine.placement.id);
  return runMachine(
    db,
    revisions(db),
    actor,
    {
      braneId: brane,
      key: uid(),
      machinePlacementId: machine.placement.id,
      model: 'mock',
      inputs: view.inputs.map(({ blockId, slot }) => ({ blockId, slot })),
      each: view.eachSlot ?? undefined,
      models,
      edits: [],
    },
    limits,
  );
};
const outputsOf = (state: ReturnType<typeof readBrane>) =>
  state.runs
    .filter((r) => r.machine_block_id === machine.id)
    .map((run) => ({
      run,
      placement: state.placements.find((p) => p.block_id === run.output_block_id)!,
    }));

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
  paper = createTextBlock(db, actor, brane, { x: 0, y: 0, width: 260, height: 160 });
  updateBlockLiveState(db, actor, { blockId: paper.id, text: 'A paper.', version: 0 });
  machine = createMachineBlock(
    db,
    actor,
    brane,
    { x: 0, y: 400, width: 400, height: 300 },
    'Summarise {source}.',
  );
  applyWorkspaceOperation(db, actor, {
    key: uid(),
    command: {
      type: 'feed.create',
      id: uid(),
      braneId: brane,
      fromPlacementId: paper.placement.id,
      toPlacementId: machine.placement.id,
      slot: 'source',
    },
  });
});
afterEach(() => db.close());

it('compares models in one press: one run each, the same inputs, answers side by side', () => {
  press(['mock', 'mock-brief']);
  const state = readBrane(db, actor, brane);
  const outputs = outputsOf(state);
  expect(outputs.map((o) => o.run.model)).toEqual(['mock', 'mock-brief']);
  expect(new Set(outputs.map((o) => o.run.batch_id)).size).toBe(1);
  expect(outputs.map((o) => o.run.batch_position)).toEqual([0, 1]);
  for (const { run } of outputs)
    expect(
      readInputs(db, run.id)
        .filter((i) => i.kind === 'reference')
        .map((i) => i.content.text),
    ).toEqual(['A paper.']);
  const [first, second] = outputs.map((o) => o.placement);
  expect(second.y).toBe(first.y);
  expect(second.x).toBeGreaterThanOrEqual(first.x + first.width);
  expect(state.groups).toEqual([]);
  // A comparison sent what one run would send: the machine is not stale after it.
  finish();
  const view = machineStaleness(readBrane(db, actor, brane), machine.placement.id);
  expect(view).toMatchObject({ ran: true, stale: false, runs: 1 });
});

it('keeps one answer: the others go on its back, and a rerun replaces the kept one', () => {
  press(['mock', 'mock-brief']);
  finish();
  const [mock, brief] = outputsOf(readBrane(db, actor, brane));
  keepOutput(db, actor, brief.run.id);
  let state = readBrane(db, actor, brane);
  expect(state.placements.find((p) => p.id === mock.placement.id)!.host_placement_id).toBe(
    brief.placement.id,
  );
  expect(state.placements.find((p) => p.id === brief.placement.id)!.host_placement_id).toBe(null);
  press();
  state = readBrane(db, actor, brane);
  const newest = outputsOf(state).find((o) => !o.run.batch_id)!;
  expect(newest.placement.host_placement_id).toBe(null);
  expect(state.placements.find((p) => p.id === brief.placement.id)!.host_placement_id).toBe(
    newest.placement.id,
  );
});

it('reruns a comparison in place, and a run together leaves one answer', () => {
  press(['mock', 'mock-brief']);
  finish();
  const before = outputsOf(readBrane(db, actor, brane)).map((o) => o.placement);
  press(['mock', 'mock-brief']);
  finish();
  let state = readBrane(db, actor, brane);
  const table = state.placements.filter(
    (p) => !p.host_placement_id && p.block_id !== paper.id && p.block_id !== machine.id,
  );
  const spots = (list: { x: number; y: number }[]) => list.map((p) => `${p.x},${p.y}`).sort();
  expect(spots(table)).toEqual(spots(before));
  press();
  state = readBrane(db, actor, brane);
  expect(
    state.placements.filter(
      (p) => !p.host_placement_id && p.block_id !== paper.id && p.block_id !== machine.id,
    ),
  ).toHaveLength(1);
});

it('refuses to compare models one card at a time, and models not allowed', () => {
  const groupId = uid();
  applyWorkspaceOperation(db, actor, {
    key: uid(),
    command: {
      type: 'group.create',
      id: groupId,
      braneId: brane,
      label: 'Papers',
      display: 'stack',
      members: [paper.placement.id],
    },
  });
  expect(() => press(['mock', 'gpt-unknown'])).toThrow('Model is not allowed');
  const view = machineStaleness(readBrane(db, actor, brane), machine.placement.id);
  expect(() =>
    runMachine(
      db,
      revisions(db),
      actor,
      {
        braneId: brane,
        key: uid(),
        machinePlacementId: machine.placement.id,
        model: 'mock',
        inputs: view.inputs.map(({ blockId, slot }) => ({ blockId, slot })),
        each: 'source',
        models: ['mock', 'mock-brief'],
        edits: [],
      },
      limits,
    ),
  ).toThrow('not one at a time');
});
