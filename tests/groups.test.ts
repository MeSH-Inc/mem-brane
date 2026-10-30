import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDatabase, type DB } from '../server/db/index';
import {
  createBrane,
  createTextBlock,
  createMachineBlock,
  updateBlockLiveState,
  removePlacement,
  revisions,
  readBrane,
  uid,
} from '../server/services/content';
import { runMachine, submitRun } from '../server/services/runs';
import { applyWorkspaceOperation } from '../server/services/workspace-operations';
import type { WorkspaceCommand } from '../shared/workspace-commands';
import { answerStaleness, machineStaleness } from '../src/canvas/machines';
import { readingOrder, regionLayout, stackLayout } from '../src/canvas/groups';

let db: DB, actor: string, brane: string;
type Card = { id: string; placement: { id: string } };
let cards: Card[];
const limits = { models: ['mock'], maxTokens: 200, userConcurrency: 10, maxContextCharacters: 1e5 };

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
  cards = ['First paper', 'Second paper', 'Third paper'].map((text, index) => {
    const card = createTextBlock(db, actor, brane, {
      x: index * 400,
      y: 0,
      width: 320,
      height: 200,
    });
    updateBlockLiveState(db, actor, { blockId: card.id, text, version: 0 });
    return card;
  });
});
afterEach(() => db.close());

const apply = (command: WorkspaceCommand) =>
  applyWorkspaceOperation(db, actor, { key: uid(), command });
const group = (members: string[], id = uid()) => {
  apply({ type: 'group.create', id, braneId: brane, label: 'Papers', display: 'region', members });
  return id;
};
const machineFedBy = (groupId: string) => {
  const machine = createMachineBlock(db, actor, brane, { x: 0, y: 600, width: 400, height: 340 });
  updateBlockLiveState(db, actor, { blockId: machine.id, text: 'Summarise {papers}.', version: 0 });
  apply({
    type: 'feed.create',
    id: uid(),
    braneId: brane,
    fromGroupId: groupId,
    toPlacementId: machine.placement.id,
    slot: 'papers',
  });
  return machine;
};
const run = (machine: Card, blockIds: string[]) =>
  runMachine(
    db,
    revisions(db),
    actor,
    {
      braneId: brane,
      key: uid(),
      machinePlacementId: machine.placement.id,
      model: 'mock',
      inputs: blockIds.map((blockId) => ({ blockId, slot: 'papers' })),
      edits: [],
    },
    limits,
  );

it('keeps members in order, one group per card, and removes an emptied group with its feeds', () => {
  const id = group([cards[1].placement.id, cards[0].placement.id]);
  expect(readBrane(db, actor, brane).groups).toMatchObject([
    {
      id,
      label: 'Papers',
      display: 'region',
      members: [cards[1].placement.id, cards[0].placement.id],
    },
  ]);
  expect(() => group([cards[0].placement.id, cards[2].placement.id])).toThrow(/one group/);
  apply({
    type: 'group.edit',
    id,
    braneId: brane,
    label: 'Reading pile',
    display: 'stack',
    members: [cards[0].placement.id, cards[1].placement.id, cards[2].placement.id],
  });
  expect(readBrane(db, actor, brane).groups[0]).toMatchObject({
    label: 'Reading pile',
    display: 'stack',
    members: cards.map((c) => c.placement.id),
  });
  machineFedBy(id);
  expect(readBrane(db, actor, brane).feeds).toMatchObject([
    { from_group_id: id, from_placement_id: null },
  ]);
  for (const card of cards) removePlacement(db, actor, card.placement.id);
  const state = readBrane(db, actor, brane);
  expect(state.groups).toEqual([]);
  expect(state.feeds).toEqual([]);
});

it('refuses machines and cards off the table as members', () => {
  const machine = createMachineBlock(db, actor, brane, { x: 0, y: 600, width: 400, height: 340 });
  expect(() => group([cards[0].placement.id, machine.placement.id])).toThrow(/Groups hold cards/);
  expect(() => group([cards[0].placement.id, uid()])).toThrow(/on the table/);
});

it('sends a fed group in member order and goes stale when the group gains a card', () => {
  const id = group([cards[0].placement.id, cards[1].placement.id]);
  const machine = machineFedBy(id);
  let state = readBrane(db, actor, brane);
  const view = machineStaleness(state, machine.placement.id);
  expect(view.inputs.map((i) => i.blockId)).toEqual([cards[0].id, cards[1].id]);
  expect(view.feeds).toMatchObject([{ groupId: id, count: 2, slot: 'papers' }]);
  run(
    machine,
    view.inputs.map((i) => i.blockId),
  );
  state = readBrane(db, actor, brane);
  expect(machineStaleness(state, machine.placement.id).stale).toBe(false);
  apply({
    type: 'group.edit',
    id,
    braneId: brane,
    label: 'Papers',
    display: 'region',
    members: cards.map((c) => c.placement.id),
  });
  const grown = machineStaleness(readBrane(db, actor, brane), machine.placement.id);
  expect(grown).toMatchObject({ stale: true, changedSlots: ['papers'] });
  expect(grown.changedFeeds).toEqual([grown.feeds[0].feedId]);
});

it('records the arrows a run sent and goes stale when one is drawn, reworded or removed', () => {
  const relation = uid();
  apply({
    type: 'relation.create',
    id: relation,
    braneId: brane,
    fromPlacementId: cards[1].placement.id,
    toPlacementId: cards[0].placement.id,
    label: 'answers',
  });
  const asked = submitRun(
    db,
    revisions(db),
    actor,
    {
      braneId: brane,
      key: uid(),
      model: 'mock',
      prompt: 'Which holds up?',
      references: [cards[0].id, cards[1].id],
      edits: [],
    },
    limits,
  );
  let state = readBrane(db, actor, brane);
  expect(state.relationEntries).toEqual([
    { runId: asked.id, fromBlockId: cards[1].id, toBlockId: cards[0].id, label: 'answers' },
  ]);
  expect(answerStaleness(state, asked.output_block_id).stale).toBe(false);
  apply({ type: 'relation.relabel', id: relation, braneId: brane, label: 'contradicts' });
  state = readBrane(db, actor, brane);
  expect(state.relations[0].label).toBe('contradicts');
  expect(answerStaleness(state, asked.output_block_id)).toMatchObject({
    sourcesChanged: false,
    arrowsChanged: true,
  });
  // The run keeps the word it froze.
  expect(state.relationEntries[0].label).toBe('answers');
  apply({ type: 'relation.remove', id: relation, braneId: brane });
  expect(answerStaleness(readBrane(db, actor, brane), asked.output_block_id).stale).toBe(true);
});

it('keeps a rerun output in its group in the replaced card’s place', () => {
  const id = group([cards[0].placement.id, cards[1].placement.id]);
  const machine = machineFedBy(id);
  const first = run(machine, [cards[0].id, cards[1].id]);
  const firstPlacement = readBrane(db, actor, brane).placements.find(
    (p) => p.block_id === first.output_block_id,
  )!;
  const outputs = group([firstPlacement.id, cards[2].placement.id]);
  run(machine, [cards[0].id, cards[1].id]);
  const state = readBrane(db, actor, brane);
  const members = state.groups.find((g) => g.id === outputs)!.members;
  expect(members[0]).not.toBe(firstPlacement.id);
  expect(state.placements.find((p) => p.id === members[0])?.host_placement_id).toBeNull();
  expect(members[1]).toBe(cards[2].placement.id);
});

it('orders cards by rows and piles or spreads them without changing member order', () => {
  const at = (x: number, y: number) => ({ x, y, width: 300, height: 200 });
  const order = readingOrder([
    { id: 'c', ...at(0, 260) },
    { id: 'b', ...at(400, 40) },
    { id: 'a', ...at(0, 0) },
  ]);
  expect(order.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  const pile = stackLayout([at(100, 100), at(700, 0), at(0, 900), at(5, 5), at(9, 9)]);
  expect(pile.map((p) => [p.x, p.y])).toEqual([
    [100, 100],
    [110, 110],
    [120, 120],
    [130, 130],
    [130, 130],
  ]);
  expect(regionLayout(pile).map((p) => [p.x, p.y])).toEqual([
    [100, 100],
    [440, 100],
    [780, 100],
    [100, 340],
    [440, 340],
  ]);
});
