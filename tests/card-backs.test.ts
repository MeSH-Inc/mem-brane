import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDatabase, type DB } from '../server/db/index';
import {
  createBrane,
  createTextBlock,
  createMachineBlock,
  createPlacement,
  updateBlockLiveState,
  removePlacement,
  revisions,
  readBrane,
  uid,
} from '../server/services/content';
import { createFeed } from '../server/services/feeds';
import { runMachine, spawnArtifact } from '../server/services/runs';
import { applyWorkspaceOperation } from '../server/services/workspace-operations';
import { backItems } from '../src/canvas/CardBack';

let db: DB, actor: string, brane: string;
let claim: { id: string; placement: { id: string } };
let critique: { id: string; placement: { id: string } };
let brief: { id: string; placement: { id: string } };
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
  critique = createMachineBlock(db, actor, brane, { x: 400, y: 0, width: 400, height: 340 });
  updateBlockLiveState(db, actor, { blockId: critique.id, text: 'Object to {claim}.', version: 0 });
  brief = createMachineBlock(db, actor, brane, { x: 1400, y: 0, width: 400, height: 340 });
  updateBlockLiveState(db, actor, { blockId: brief.id, text: 'Summarise {notes}.', version: 0 });
  createFeed(db, actor, {
    id: uid(),
    braneId: brane,
    fromPlacementId: claim.placement.id,
    toPlacementId: critique.placement.id,
    slot: 'claim',
  });
});
afterEach(() => db.close());

const placementOf = (blockId: string) =>
  readBrane(db, actor, brane).placements.find((p) => p.block_id === blockId)!;
const runCritique = () =>
  runMachine(
    db,
    revisions(db),
    actor,
    {
      braneId: brane,
      key: uid(),
      machinePlacementId: critique.placement.id,
      model: 'mock',
      inputs: [{ blockId: claim.id, slot: 'claim' }],
      edits: [],
    },
    limits,
  );

it('puts a development on its source card’s back, not on the table', () => {
  const run = spawnArtifact(
    db,
    revisions(db),
    actor,
    {
      braneId: brane,
      key: uid(),
      sourceBlockIds: [claim.id],
      anchorPlacementId: claim.placement.id,
      action: 'develop',
      model: 'mock',
      edits: [],
    },
    limits,
  );
  const development = placementOf(run.output_block_id);
  expect(development.host_placement_id).toBe(claim.placement.id);
  const state = readBrane(db, actor, brane);
  expect(state.blocks.map((b) => b.id)).toContain(run.output_block_id);
  expect(state.derivations.find((d) => d.outputBlockId === run.output_block_id)?.kind).toBe(
    'source',
  );
});

it('moves a machine’s replaced output, its back and its feeds to the new output', () => {
  const first = runCritique();
  const firstPlacement = placementOf(first.output_block_id);
  expect(firstPlacement.host_placement_id).toBeNull();
  // The first critique feeds a downstream machine, between two other notes.
  const note = createTextBlock(db, actor, brane, { x: 0, y: 600, width: 320, height: 200 });
  const later = createTextBlock(db, actor, brane, { x: 0, y: 900, width: 320, height: 200 });
  for (const from of [note.placement.id, firstPlacement.id, later.placement.id])
    createFeed(db, actor, {
      id: uid(),
      braneId: brane,
      fromPlacementId: from,
      toPlacementId: brief.placement.id,
      slot: 'notes',
    });

  const second = runCritique();
  const secondPlacement = placementOf(second.output_block_id);
  expect(secondPlacement).toMatchObject({
    host_placement_id: null,
    x: firstPlacement.x,
    y: firstPlacement.y,
  });
  expect(placementOf(first.output_block_id).host_placement_id).toBe(secondPlacement.id);
  expect(
    readBrane(db, actor, brane)
      .feeds.filter((f) => f.to_placement_id === brief.placement.id)
      .map((f) => f.from_placement_id),
  ).toEqual([note.placement.id, secondPlacement.id, later.placement.id]);

  // A third run keeps every earlier version on one back, newest output on the table.
  const third = runCritique();
  const thirdPlacement = placementOf(third.output_block_id);
  const state = readBrane(db, actor, brane);
  const hosted = state.placements.filter((p) => p.host_placement_id === thirdPlacement.id);
  expect(hosted.map((p) => p.block_id).sort()).toEqual(
    [first.output_block_id, second.output_block_id].sort(),
  );
  const runs = Object.fromEntries(state.runs.map((r) => [r.output_block_id, r]));
  expect(
    backItems(state.placements, runs, thirdPlacement.id)
      .map((item) => [item.blockId, item.earlier])
      .sort(),
  ).toEqual(
    [
      [second.output_block_id, true],
      [first.output_block_id, true],
    ].sort(),
  );
});

it('puts a card from a back onto the table through a synchronized operation', () => {
  runCritique();
  const second = runCritique();
  const host = placementOf(second.output_block_id);
  const earlier = readBrane(db, actor, brane).placements.find(
    (p) => p.host_placement_id === host.id,
  )!;
  const geometry = { x: 900, y: 500, width: 380, height: 300 };
  applyWorkspaceOperation(db, actor, {
    key: uid(),
    command: {
      type: 'placement.detach',
      id: earlier.id,
      braneId: brane,
      hostPlacementId: host.id,
      version: earlier.version,
      geometry,
    },
  });
  expect(placementOf(earlier.block_id)).toMatchObject({
    ...geometry,
    host_placement_id: null,
    version: earlier.version + 1,
  });
  expect(() =>
    applyWorkspaceOperation(db, actor, {
      key: uid(),
      command: {
        type: 'placement.detach',
        id: earlier.id,
        braneId: brane,
        hostPlacementId: host.id,
        version: earlier.version + 1,
        geometry,
      },
    }),
  ).toThrow(/moved off that back/);
});

it('removes a back with its host and keeps backs one level deep', () => {
  runCritique();
  const second = runCritique();
  const host = placementOf(second.output_block_id);
  const earlier = readBrane(db, actor, brane).placements.find(
    (p) => p.host_placement_id === host.id,
  )!;
  expect(() => createPlacement(db, actor, brane, claim.id, undefined, uid(), earlier.id)).toThrow(
    /invalid placement host/,
  );
  removePlacement(db, actor, host.id);
  expect(readBrane(db, actor, brane).placements.map((p) => p.id)).not.toContain(earlier.id);
});
