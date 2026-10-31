import { afterEach, beforeEach, expect, it } from 'vitest';
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
import { estimateMachine, runMachine } from '../server/services/runs';
import { readInputs } from '../server/services/context-reader';
import { claimRun } from '../server/services/run-lifecycle';
import { applyWorkspaceOperation } from '../server/services/workspace-operations';
import {
  readWorkshop,
  removeWorkshopMachine,
  saveWorkshopMachine,
} from '../server/services/workshop';
import type { WorkspaceCommand } from '../shared/workspace-commands';
import { machineStaleness } from '../src/canvas/machines';

let db: DB, actor: string, brane: string;
let papers: { id: string; placement: { id: string } }[];
let machine: { id: string; placement: { id: string } };
let feedId: string, groupId: string;
const limits = { models: ['mock'], maxTokens: 200, userConcurrency: 2, maxContextCharacters: 1e5 };

const apply = (command: WorkspaceCommand) =>
  applyWorkspaceOperation(db, actor, { key: uid(), command });
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
  papers = [1, 2, 3].map((n) => {
    const card = createTextBlock(db, actor, brane, { x: n * 300, y: 0, width: 260, height: 160 });
    updateBlockLiveState(db, actor, { blockId: card.id, text: `Paper ${n}`, version: 0 });
    return card;
  });
  machine = createMachineBlock(
    db,
    actor,
    brane,
    { x: 0, y: 400, width: 400, height: 300 },
    'Extract the method of {source}, as asked by {question}.',
  );
  const question = createTextBlock(db, actor, brane, { x: 0, y: 800, width: 260, height: 160 });
  updateBlockLiveState(db, actor, { blockId: question.id, text: 'Which method?', version: 0 });
  groupId = uid();
  apply({
    type: 'group.create',
    id: groupId,
    braneId: brane,
    label: 'Papers',
    display: 'stack',
    members: papers.map((p) => p.placement.id),
  });
  feedId = uid();
  apply({
    type: 'feed.create',
    id: feedId,
    braneId: brane,
    fromGroupId: groupId,
    toPlacementId: machine.placement.id,
    slot: 'source',
  });
  apply({
    type: 'feed.create',
    id: uid(),
    braneId: brane,
    fromPlacementId: question.placement.id,
    toPlacementId: machine.placement.id,
    slot: 'question',
  });
  apply({ type: 'feed.mode', id: feedId, braneId: brane, mode: 'each' });
});
afterEach(() => db.close());

// Runs finish between presses, so the concurrency limit never decides a test here.
const finish = () => db.prepare("UPDATE runs SET status='completed'").run();
const press = (key = uid()) => {
  const view = machineStaleness(readBrane(db, actor, brane), machine.placement.id);
  return runMachine(
    db,
    revisions(db),
    actor,
    {
      braneId: brane,
      key,
      machinePlacementId: machine.placement.id,
      model: 'mock',
      inputs: view.inputs.map(({ blockId, slot }) => ({ blockId, slot })),
      each: view.eachSlot ?? undefined,
      edits: [],
    },
    limits,
  );
};
const outputStack = () => {
  const state = readBrane(db, actor, brane);
  const outputs = new Set(state.runs.map((r) => r.output_block_id));
  return state.groups.find((g) =>
    g.members.every((id) => outputs.has(state.placements.find((p) => p.id === id)!.block_id)),
  );
};

it('admits one run per card of the each slot, frozen at the press, as one stack', () => {
  const view = machineStaleness(readBrane(db, actor, brane), machine.placement.id);
  expect(view).toMatchObject({ eachSlot: 'source', runs: 3 });
  const estimate = estimateMachine(
    db,
    actor,
    {
      braneId: brane,
      key: uid(),
      machinePlacementId: machine.placement.id,
      model: 'mock',
      inputs: view.inputs.map(({ blockId, slot }) => ({ blockId, slot })),
      each: 'source',
      edits: [],
    },
    limits,
  );
  expect(estimate.runs).toBe(3);
  const key = uid();
  const first = press(key);
  // Three runs count once against a concurrency limit of two.
  const state = readBrane(db, actor, brane);
  expect(state.runs).toHaveLength(3);
  expect(new Set(state.runs.map((r) => r.batch_id))).toEqual(new Set([key]));
  expect(state.runs.map((r) => r.batch_position).sort()).toEqual([0, 1, 2]);
  const sent = [...state.runs]
    .sort((a, b) => a.batch_position! - b.batch_position!)
    .map((r) =>
      readInputs(db, r.id)
        .filter((i) => i.kind === 'reference')
        .map((i) => `${i.label}:${i.content.text}`),
    );
  expect(sent).toEqual([
    ['source:Paper 1', 'question:Which method?'],
    ['source:Paper 2', 'question:Which method?'],
    ['source:Paper 3', 'question:Which method?'],
  ]);
  expect(outputStack()).toMatchObject({ label: 'Each source', display: 'stack' });
  expect(outputStack()!.members).toHaveLength(3);
  expect(machineStaleness(readBrane(db, actor, brane), machine.placement.id).stale).toBe(false);
  // A repeated press returns its runs without admitting more.
  expect(press(key).id).toBe(first.id);
  expect(readBrane(db, actor, brane).runs).toHaveLength(3);
});

it('reruns in place: each output on its replacement’s back, surplus on the first one’s', () => {
  press();
  const before = outputStack()!.members;
  apply({
    type: 'group.edit',
    id: groupId,
    braneId: brane,
    label: 'Papers',
    display: 'stack',
    members: papers.slice(0, 2).map((p) => p.placement.id),
  });
  const view = machineStaleness(readBrane(db, actor, brane), machine.placement.id);
  expect(view).toMatchObject({ stale: true, changedSlots: ['source', 'question'], runs: 2 });
  finish();
  press();
  const state = readBrane(db, actor, brane);
  const after = outputStack()!.members;
  expect(after).toHaveLength(2);
  const host = (id: string) => state.placements.find((p) => p.id === id)!.host_placement_id;
  expect(host(before[0])).toBe(after[0]);
  expect(host(before[1])).toBe(after[1]);
  expect(host(before[2])).toBe(after[0]);
  expect(machineStaleness(state, machine.placement.id).stale).toBe(false);
  // Together again: one output where the stack was, the stack's cards on its back.
  apply({ type: 'feed.mode', id: feedId, braneId: brane, mode: 'together' });
  expect(machineStaleness(readBrane(db, actor, brane), machine.placement.id)).toMatchObject({
    stale: true,
    runs: 1,
  });
  finish();
  press();
  const together = readBrane(db, actor, brane);
  expect(outputStack()).toBeUndefined();
  const output = together.placements.find(
    (p) => p.block_id === together.runs.at(-1)!.output_block_id,
  )!;
  const heldBy = (id: string) => together.placements.find((p) => p.id === id)!.host_placement_id;
  expect(heldBy(after[0])).toBe(output.id);
  expect(heldBy(after[1])).toBe(output.id);
  // Backs are one level deep: the stack's cards and their earlier versions all move.
  expect(together.placements.filter((p) => p.host_placement_id === output.id)).toHaveLength(5);
});

it('refuses each on a card feed or on a second slot', () => {
  const single = readBrane(db, actor, brane).feeds.find((f) => f.slot === 'question')!;
  expect(() => apply({ type: 'feed.mode', id: single.id, braneId: brane, mode: 'each' })).toThrow(
    /Only a group/,
  );
  const questions = uid();
  apply({
    type: 'group.create',
    id: questions,
    braneId: brane,
    label: 'Questions',
    display: 'region',
    members: [single.from_placement_id!],
  });
  const second = uid();
  apply({
    type: 'feed.create',
    id: second,
    braneId: brane,
    fromGroupId: questions,
    toPlacementId: machine.placement.id,
    slot: 'question',
  });
  expect(() => apply({ type: 'feed.mode', id: second, braneId: brane, mode: 'each' })).toThrow(
    /already runs each/,
  );
});

it('shares workers fairly between owners', () => {
  press();
  const other = uid();
  db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
    other,
    'Other',
    `${other}@example.com`,
    Date.now(),
    Date.now(),
  );
  const otherBrane = createBrane(db, other).id;
  const card = createTextBlock(db, other, otherBrane);
  updateBlockLiveState(db, other, { blockId: card.id, text: 'Hello', version: 0 });
  const otherMachine = createMachineBlock(db, other, otherBrane, undefined, 'Read {text}.');
  const otherRun = runMachine(
    db,
    revisions(db),
    other,
    {
      braneId: otherBrane,
      key: uid(),
      machinePlacementId: otherMachine.placement.id,
      model: 'mock',
      inputs: [{ blockId: card.id, slot: 'text' }],
      edits: [],
    },
    limits,
  );
  expect(claimRun(db, 'w', 1000)!.owner_id).toBe(actor);
  expect(claimRun(db, 'w', 1000)!.id).toBe(otherRun.id);
});

it('keeps saved machines in the Workshop beside the built-in ones', () => {
  expect(readWorkshop(db, actor).builtIn.map((m) => m.name)).toEqual([
    'Critique',
    'Distill',
    'Split',
    'Diagram',
    'Extract',
  ]);
  const saved = saveWorkshopMachine(db, actor, 'Method', 'Extract the method of {source}.');
  expect(readWorkshop(db, actor).saved).toMatchObject([{ id: saved.id, name: 'Method' }]);
  removeWorkshopMachine(db, actor, saved.id);
  expect(readWorkshop(db, actor).saved).toEqual([]);
});
