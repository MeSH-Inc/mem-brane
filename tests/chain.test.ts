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
import { keepOutput, runMachine } from '../server/services/runs';
import { completeAttempt, startAttempt } from '../server/services/run-lifecycle';
import { applyWorkspaceOperation } from '../server/services/workspace-operations';
import { feedClosesLoop } from '../shared/machines';
import { machineStaleness, machineTray } from '../src/canvas/machines';

let db: DB, actor: string, brane: string;
type Machine = ReturnType<typeof createMachineBlock>;
let papers: ReturnType<typeof createTextBlock>[];
let distill: Machine, brief: Machine;
const limits = {
  models: ['mock', 'mock-brief'],
  maxTokens: 200,
  userConcurrency: 8,
  maxContextCharacters: 1e5,
};
// The worker's completion of every queued run, with a short answer.
const finish = () => {
  const queued = db
    .prepare<[], { id: string }>("SELECT id FROM runs WHERE status='queued'")
    .pluck()
    .all() as unknown as string[];
  for (const runId of queued) {
    db.prepare("UPDATE runs SET status='claimed',lease_owner='w',lease_until=? WHERE id=?").run(
      Date.now() + 60000,
      runId,
    );
    completeAttempt(db, startAttempt(db, runId, 'w')!, { text: `Answer of ${runId}.` });
  }
};
const state = () => readBrane(db, actor, brane);
const press = (machine: Machine, models?: string[]) => {
  const view = machineStaleness(state(), machine.placement.id);
  const run = runMachine(
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
  finish();
  return run;
};
const operate = (command: Record<string, unknown>) =>
  applyWorkspaceOperation(db, actor, {
    key: uid(),
    command: { id: uid(), braneId: brane, ...command } as never,
  });
const feed = (source: { placementId: string } | { groupId: string }, to: Machine, slot: string) =>
  operate({
    type: 'feed.create',
    ...('placementId' in source
      ? { fromPlacementId: source.placementId }
      : { fromGroupId: source.groupId }),
    toPlacementId: to.placement.id,
    slot,
  });
const feedsInto = (machine: Machine) =>
  state().feeds.filter((f) => f.to_placement_id === machine.placement.id);
const tray = (machine: Machine) => machineTray(state(), machine.placement.id)!;

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
  papers = [0, 1].map((index) => {
    const paper = createTextBlock(db, actor, brane, {
      x: index * 300,
      y: 0,
      width: 260,
      height: 160,
    });
    updateBlockLiveState(db, actor, { blockId: paper.id, text: `Paper ${index}.`, version: 0 });
    return paper;
  });
  distill = createMachineBlock(
    db,
    actor,
    brane,
    { x: 0, y: 400, width: 400, height: 300 },
    'Distill {source}.',
  );
  brief = createMachineBlock(
    db,
    actor,
    brane,
    { x: 900, y: 400, width: 400, height: 300 },
    'Brief from {material}.',
  );
  for (const paper of papers) feed({ placementId: paper.placement.id }, distill, 'source');
});
afterEach(() => db.close());

it('feeds the newest answer onward, and a rerun upstream makes the next machine stale', () => {
  expect(machineTray(state(), distill.placement.id)).toBe(null);
  press(distill);
  const first = tray(distill);
  expect(first).toHaveProperty('placementId');
  feed(first, brief, 'material');
  press(brief);
  expect(machineStaleness(state(), brief.placement.id)).toMatchObject({ stale: false });
  // An upstream edit makes only the upstream machine stale; nothing runs by itself.
  updateBlockLiveState(db, actor, { blockId: papers[0].id, text: 'Paper 0, revised.', version: 1 });
  expect(machineStaleness(state(), distill.placement.id)).toMatchObject({ stale: true });
  expect(machineStaleness(state(), brief.placement.id)).toMatchObject({ stale: false });
  const runs = state().runs.length;
  press(distill);
  expect(state().runs).toHaveLength(runs + 1);
  // The feed followed the tray to the new answer; the downstream machine is now stale.
  const second = tray(distill);
  expect(second).not.toEqual(first);
  expect(feedsInto(brief).map((f) => f.from_placement_id)).toEqual([
    (second as { placementId: string }).placementId,
  ]);
  expect(machineStaleness(state(), brief.placement.id)).toMatchObject({
    stale: true,
    changedSlots: ['material'],
  });
  press(brief);
  expect(machineStaleness(state(), brief.placement.id)).toMatchObject({ stale: false });
});

it('refuses a feed that would close a loop, directly or through another machine', () => {
  press(distill);
  feed(tray(distill), brief, 'material');
  press(brief);
  expect(feedClosesLoop(state(), tray(brief), distill.placement.id)).toBe(true);
  expect(() => feed(tray(brief), distill, 'source')).toThrow('close a loop');
  expect(() => feed(tray(distill), distill, 'source')).toThrow('close a loop');
  // A third machine downstream of both is no loop.
  const third = createMachineBlock(
    db,
    actor,
    brane,
    { x: 1800, y: 400, width: 400, height: 300 },
    'Check {claim}.',
  );
  expect(feedClosesLoop(state(), tray(brief), third.placement.id)).toBe(false);
  feed(tray(brief), third, 'claim');
});

it('keeps a tray feed as the tray changes between a stack and one card', () => {
  const groupId = uid();
  operate({
    type: 'group.create',
    id: groupId,
    label: 'Papers',
    display: 'stack',
    members: papers.map((p) => p.placement.id),
  });
  for (const f of feedsInto(distill)) operate({ type: 'feed.remove', id: f.id });
  feed({ groupId }, distill, 'source');
  press(distill);
  feed(tray(distill), brief, 'material');
  // Each: the one card's feed becomes the new stack's.
  operate({ type: 'feed.mode', id: feedsInto(distill)[0].id, mode: 'each' });
  press(distill);
  const stack = tray(distill);
  expect(stack).toHaveProperty('groupId');
  expect(feedsInto(brief)).toMatchObject([
    { from_group_id: (stack as { groupId: string }).groupId },
  ]);
  // Together again: the stack's feed becomes the one card's.
  operate({ type: 'feed.mode', id: feedsInto(distill)[0].id, mode: 'together' });
  press(distill);
  const card = tray(distill);
  expect(card).toHaveProperty('placementId');
  expect(feedsInto(brief)).toMatchObject([
    { from_placement_id: (card as { placementId: string }).placementId, from_group_id: null },
  ]);
});

it('moves a feed from a compared answer to the kept one', () => {
  press(distill, ['mock', 'mock-brief']);
  const outputs = state()
    .runs.filter((r) => r.machine_block_id === distill.id)
    .map((run) => state().placements.find((p) => p.block_id === run.output_block_id)!);
  feed({ placementId: outputs[0].id }, brief, 'material');
  const briefRun = state().runs.find((r) => r.output_block_id === outputs[1].block_id)!;
  keepOutput(db, actor, briefRun.id);
  expect(feedsInto(brief).map((f) => f.from_placement_id)).toEqual([outputs[1].id]);
});
