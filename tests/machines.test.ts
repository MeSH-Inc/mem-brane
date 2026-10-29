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
import { runMachine, estimateMachine } from '../server/services/runs';
import { readInputs } from '../server/services/context-reader';
import { applyWorkspaceOperation } from '../server/services/workspace-operations';
import { buildMessages } from '../server/llm/model';
import { RunWorker } from '../server/jobs/worker';
import { EventHub } from '../server/sse/hub';
import { machineSlots, orderMachineInputs, type RunMachine } from '../shared/machines';
import { machineStaleness } from '../src/canvas/machines';

let db: DB, actor: string, brane: string;
let claim: { id: string; placement: { id: string } };
let study: { id: string; placement: { id: string } };
let machine: { id: string; placement: { id: string } };
const limits = { models: ['mock'], maxTokens: 200, userConcurrency: 10, maxContextCharacters: 1e5 };

function request(extra: Partial<RunMachine> = {}): RunMachine {
  return {
    braneId: brane,
    key: uid(),
    machinePlacementId: machine.placement.id,
    model: 'mock',
    inputs: [
      { blockId: study.id, slot: 'evidence' },
      { blockId: claim.id, slot: 'claim' },
    ],
    edits: [],
    ...extra,
  };
}
const run = (input = request()) => runMachine(db, revisions(db), actor, input, limits);

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
  claim = createTextBlock(db, actor, brane);
  study = createTextBlock(db, actor, brane);
  updateBlockLiveState(db, actor, { blockId: claim.id, text: 'Transit raises rents', version: 0 });
  updateBlockLiveState(db, actor, { blockId: study.id, text: 'Rents rose 8%', version: 0 });
  machine = createMachineBlock(db, actor, brane);
});
afterEach(() => db.close());

it('derives slots from the template in order, once each', () => {
  expect(machineSlots('Weigh {claim} against {evidence}; restate {claim}.')).toEqual([
    'claim',
    'evidence',
  ]);
  expect(machineSlots('No slots here, {} or {\n}.')).toEqual([]);
  expect(
    orderMachineInputs('{a} then {b}', [
      { blockId: '2', slot: 'b' },
      { blockId: '1', slot: 'a' },
      { blockId: '3', slot: 'a' },
    ]).map((i) => i.blockId),
  ).toEqual(['1', '3', '2']);
});

it('freezes the machine revision as the prompt and labels each input with its slot', () => {
  const queued = run();
  const inputs = readInputs(db, queued.id);
  expect(inputs.map((i) => [i.kind, i.label])).toEqual([
    ['reference', 'claim'],
    ['reference', 'evidence'],
    ['prompt', 'Prompt'],
  ]);
  expect(inputs[2].content.text).toContain('{claim}');
  expect(buildMessages(inputs)[0].content).toContain('Reference material: claim');
  const state = readBrane(db, actor, brane);
  const record = state.runs.find((r) => r.id === queued.id)!;
  expect(record).toMatchObject({ machine_block_id: machine.id, machine_version: 0 });
  const output = state.placements.find((p) => p.block_id === queued.output_block_id)!;
  const anchor = state.placements.find((p) => p.id === machine.placement.id)!;
  expect(output.x).toBeGreaterThan(anchor.x + anchor.width);
  expect(state.derivations.filter((d) => d.runId === queued.id).map((d) => d.label)).toEqual([
    'claim',
    'evidence',
  ]);
});

it('freezes an unsaved template edit and rejects inputs the template does not name', () => {
  const queued = run(
    request({
      inputs: [{ blockId: claim.id, slot: 'thesis' }],
      edits: [{ blockId: machine.id, text: 'Steelman {thesis}.', version: 0 }],
    }),
  );
  expect(readInputs(db, queued.id).at(-1)!.content.text).toBe('Steelman {thesis}.');
  expect(() => run(request({ inputs: [{ blockId: claim.id, slot: 'claim' }] }))).toThrow(
    'no {claim} slot',
  );
  updateBlockLiveState(db, actor, { blockId: machine.id, text: '{a} and {b}', version: 1 });
  expect(() => run(request({ inputs: [{ blockId: claim.id, slot: 'a' }] }))).toThrow(
    'Feed the {b} slot',
  );
  expect(() =>
    run(
      request({
        inputs: [
          { blockId: claim.id, slot: 'a' },
          { blockId: study.id, slot: 'b' },
        ],
        edits: [{ blockId: uid(), text: 'x', version: 0 }],
      }),
    ),
  ).toThrow('Only the machine and its inputs');
});

it('estimates without writing and refuses running a card as a machine', () => {
  const before = db.prepare('SELECT count(*) n FROM runs').get();
  expect(estimateMachine(db, actor, request(), limits).reservedMicrousd).toBeGreaterThanOrEqual(0);
  expect(db.prepare('SELECT count(*) n FROM runs').get()).toEqual(before);
  expect(() => run(request({ machinePlacementId: claim.placement.id }))).toThrow('Only a machine');
});

it('validates feed endpoints and removes feeds with their placements', () => {
  const feed = (from: string, to: string, slot = 'claim') =>
    createFeed(db, actor, {
      id: uid(),
      braneId: brane,
      fromPlacementId: from,
      toPlacementId: to,
      slot,
    });
  feed(claim.placement.id, machine.placement.id);
  expect(() => feed(claim.placement.id, machine.placement.id)).toThrow('already feeds');
  expect(() => feed(claim.placement.id, study.placement.id)).toThrow('end on a machine');
  expect(() => feed(machine.placement.id, machine.placement.id)).toThrow('cannot feed a machine');
  feed(study.placement.id, machine.placement.id, 'evidence');
  expect(readBrane(db, actor, brane).feeds.map((f) => f.slot)).toEqual(['claim', 'evidence']);
  removePlacement(db, actor, claim.placement.id);
  expect(readBrane(db, actor, brane).feeds.map((f) => f.slot)).toEqual(['evidence']);
});

it('creates machines and feeds through synchronized workspace operations', () => {
  const blockId = uid(),
    placementId = uid(),
    feedId = uid();
  const geometry = { x: 0, y: 0, width: 360, height: 260 };
  applyWorkspaceOperation(db, actor, {
    key: uid(),
    command: {
      type: 'block.create',
      kind: 'machine',
      braneId: brane,
      blockId,
      placementId,
      geometry,
    },
  });
  applyWorkspaceOperation(db, actor, {
    key: uid(),
    command: {
      type: 'feed.create',
      id: feedId,
      braneId: brane,
      fromPlacementId: claim.placement.id,
      toPlacementId: placementId,
      slot: 'claim',
    },
  });
  const state = readBrane(db, actor, brane);
  expect(state.blocks.find((b) => b.id === blockId)).toMatchObject({ kind: 'machine' });
  expect(state.feeds.map((f) => f.id)).toContain(feedId);
  applyWorkspaceOperation(db, actor, {
    key: uid(),
    command: { type: 'feed.remove', id: feedId, braneId: brane },
  });
  expect(readBrane(db, actor, brane).feeds.map((f) => f.id)).not.toContain(feedId);
});

it('marks a machine stale when a fed card, its feeds or its template change after a run', async () => {
  for (const [from, slot] of [
    [claim.placement.id, 'claim'],
    [study.placement.id, 'evidence'],
  ])
    createFeed(db, actor, {
      id: uid(),
      braneId: brane,
      fromPlacementId: from,
      toPlacementId: machine.placement.id,
      slot,
    });
  const worker = new RunWorker(
    db,
    new EventHub(),
    async (_request, chunk) => {
      chunk('Objection');
      return { text: 'Objection' };
    },
    { concurrency: 1, leaseMs: 5000, checkpointMs: 5, checkpointCharacters: 1 },
  );
  run();
  await worker.tick();
  await worker.stop();
  const staleness = () => machineStaleness(readBrane(db, actor, brane), machine.placement.id);
  expect(staleness()).toMatchObject({ ran: true, stale: false });
  updateBlockLiveState(db, actor, { blockId: study.id, text: 'Rents rose 12%', version: 1 });
  expect(staleness()).toMatchObject({ stale: true, changedSlots: ['evidence'] });
  run();
  expect(staleness()).toMatchObject({ stale: false });
  updateBlockLiveState(db, actor, {
    blockId: machine.id,
    text: 'Doubt {claim}; {evidence}',
    version: 0,
  });
  expect(staleness()).toMatchObject({ stale: true, templateChanged: true });
});
