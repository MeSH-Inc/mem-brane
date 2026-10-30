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
import { createFeed } from '../server/services/feeds';
import { createRelation } from '../server/services/relations';
import { runMachine, submitRun } from '../server/services/runs';
import { readInputs } from '../server/services/context-reader';
import { buildMessages } from '../server/llm/model';
import { applyWorkspaceOperation } from '../server/services/workspace-operations';
import { readUnplacedCards } from '../server/services/card-library';

let db: DB, actor: string, brane: string;
let claim: { id: string; placement: { id: string } };
let objection: { id: string; placement: { id: string } };
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
  claim = createTextBlock(db, actor, brane, { x: 0, y: 0, width: 320, height: 200 });
  updateBlockLiveState(db, actor, { blockId: claim.id, text: 'Transit raises rents', version: 0 });
  objection = createTextBlock(db, actor, brane, { x: 400, y: 0, width: 320, height: 200 });
  updateBlockLiveState(db, actor, {
    blockId: objection.id,
    text: 'Rents rose before the line opened',
    version: 0,
  });
});
afterEach(() => db.close());

const relate = (from: string, to: string, label = 'answers') =>
  applyWorkspaceOperation(db, actor, {
    key: uid(),
    command: {
      type: 'relation.create',
      id: uid(),
      braneId: brane,
      fromPlacementId: from,
      toPlacementId: to,
      label,
    },
  });
const ask = (references: string[], extra: Record<string, unknown> = {}) =>
  submitRun(
    db,
    revisions(db),
    actor,
    {
      braneId: brane,
      key: uid(),
      model: 'mock',
      prompt: 'Which holds up?',
      references,
      edits: [],
      ...extra,
    },
    limits,
  );

it('sends an arrow between two inputs as a frozen relation entry before the prompt', () => {
  relate(objection.placement.id, claim.placement.id);
  const run = ask([claim.id, objection.id]);
  const inputs = readInputs(db, run.id);
  expect(inputs.map((i) => i.kind)).toEqual(['reference', 'reference', 'relation', 'prompt']);
  expect(inputs[2].content.text).toBe('Reference 2 answers Reference 1.');
  expect(buildMessages(inputs)[2].content).toBe(
    '[Relation between reference materials] Reference 2 answers Reference 1.',
  );
  // The relation's frozen text is request material, not a card to recover.
  expect(readUnplacedCards(db, actor, 50).items.map((b) => b.preview)).not.toContain(
    'Reference 2 answers Reference 1.',
  );
  // Only one end among the inputs sends nothing.
  expect(readInputs(db, ask([claim.id]).id).map((i) => i.kind)).toEqual(['reference', 'prompt']);
});

it('names ends that share a slot by their frozen revision', () => {
  const machine = createMachineBlock(db, actor, brane, { x: 800, y: 0, width: 400, height: 340 });
  updateBlockLiveState(db, actor, { blockId: machine.id, text: 'Weigh {notes}.', version: 0 });
  for (const from of [claim.placement.id, objection.placement.id])
    createFeed(db, actor, {
      id: uid(),
      braneId: brane,
      fromPlacementId: from,
      toPlacementId: machine.placement.id,
      slot: 'notes',
    });
  relate(objection.placement.id, claim.placement.id, 'contradicts');
  const run = runMachine(
    db,
    revisions(db),
    actor,
    {
      braneId: brane,
      key: uid(),
      machinePlacementId: machine.placement.id,
      model: 'mock',
      inputs: [
        { blockId: claim.id, slot: 'notes' },
        { blockId: objection.id, slot: 'notes' },
      ],
      edits: [],
    },
    limits,
  );
  const inputs = readInputs(db, run.id);
  expect(inputs[2].content.text).toBe(
    `notes (revision ${inputs[1].revision_id}) contradicts notes (revision ${inputs[0].revision_id}).`,
  );
});

it('refuses arrows off the table and removes them with either card', () => {
  expect(() =>
    createRelation(db, actor, {
      id: uid(),
      braneId: brane,
      fromPlacementId: claim.placement.id,
      toPlacementId: claim.placement.id,
      label: 'answers',
    }),
  ).toThrow(/two different cards/);
  relate(objection.placement.id, claim.placement.id);
  expect(() => relate(objection.placement.id, claim.placement.id)).toThrow(/already joins/);
  removePlacement(db, actor, claim.placement.id);
  expect(readBrane(db, actor, brane).relations).toEqual([]);
});

it('updates an asked answer in place and keeps its arrows on the new answer', () => {
  const first = ask([claim.id], { outputGeometry: { x: 40, y: 600, width: 380, height: 300 } });
  const firstPlacement = readBrane(db, actor, brane).placements.find(
    (p) => p.block_id === first.output_block_id,
  )!;
  relate(objection.placement.id, firstPlacement.id);
  updateBlockLiveState(db, actor, { blockId: claim.id, text: 'Transit lowers rents', version: 1 });
  const second = ask([claim.id], { replacesPlacementId: firstPlacement.id });
  const state = readBrane(db, actor, brane);
  const secondPlacement = state.placements.find((p) => p.block_id === second.output_block_id)!;
  expect(secondPlacement).toMatchObject({ x: 40, y: 600, host_placement_id: null });
  expect(state.placements.find((p) => p.id === firstPlacement.id)?.host_placement_id).toBe(
    secondPlacement.id,
  );
  expect(state.relations.map((r) => [r.from_placement_id, r.to_placement_id])).toEqual([
    [objection.placement.id, secondPlacement.id],
  ]);
  // The old answer is on a back now; it cannot be replaced again.
  expect(() => ask([claim.id], { replacesPlacementId: firstPlacement.id })).toThrow(
    /no longer on the table/,
  );
});
