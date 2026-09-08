import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDatabase, type DB } from '../server/db/index';
import {
  createBrane,
  createTextBlock,
  createBlock,
  createPlacement,
  updateBlockLiveState,
  revisions,
  readBrane,
  removePlacement,
  uid,
} from '../server/services/content';
import { spawnArtifact, retryRun, cancelRun } from '../server/services/runs';
import { readInputs } from '../server/services/contexts';
import { RunWorker } from '../server/jobs/worker';
import { EventHub } from '../server/sse/hub';
import { derivationEdges } from '../src/canvas/derivations';
import { buildMessages } from '../server/llm/model';
import { spawnArtifact as schema } from '../shared/schemas';
import type { SpawnArtifact, BraneState } from '../shared/types/domain';
let db: DB, actor: string, brane: string, block: string, placement: string;
const limits = {
  models: ['mock'],
  maxTokens: 200,
  userConcurrency: 10,
  maxContextCharacters: 100000,
};
function request(extra: Partial<SpawnArtifact> = {}): SpawnArtifact {
  return {
    braneId: brane,
    key: uid(),
    sourceBlockIds: [block],
    anchorPlacementId: placement,
    model: 'mock',
    action: 'develop',
    edits: [],
    ...extra,
  };
}
const spawn = (input = request()) => spawnArtifact(db, revisions(db), actor, input, limits);
const state = () => readBrane(db, actor, brane) as BraneState;
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
  const source = createTextBlock(db, actor, brane);
  block = source.id;
  placement = source.placement.id;
  updateBlockLiveState(db, actor, { blockId: block, text: 'Original', version: 0 });
});
afterEach(() => db.close());
it('atomically freezes unsaved edits, queues a generated text child, and restores its exact source link', () => {
  const run = spawn(request({ edits: [{ blockId: block, text: 'Unsaved idea', version: 1 }] }));
  const inputs = readInputs(db, run.id);
  expect(inputs.map((i) => i.kind)).toEqual(['source', 'prompt']);
  expect(inputs[0].content.text).toBe('Unsaved idea');
  expect(buildMessages(inputs)[0].content).toContain('Unsaved idea');
  expect(run.status).toBe('queued');
  expect(state().blocks.find((b) => b.id === run.output_block_id)).toMatchObject({
    kind: 'text',
    origin: 'generated',
  });
  expect(() =>
    updateBlockLiveState(db, actor, {
      blockId: run.output_block_id,
      text: 'overwrite',
      version: 0,
    }),
  ).toThrow('not editable');
  updateBlockLiveState(db, actor, { blockId: block, text: 'Later', version: 2 });
  expect(readInputs(db, run.id)[0].content.text).toBe('Unsaved idea');
  const restored = state();
  expect(restored.derivations[0]).toMatchObject({
    sourceBlockId: block,
    sourceRevisionId: inputs[0].revision_id,
    outputBlockId: run.output_block_id,
    anchorPlacementId: placement,
  });
  expect(derivationEdges(restored)).toHaveLength(1);
  const child = restored.placements.find((p) => p.block_id === run.output_block_id)!;
  expect(child.x).toBeGreaterThan(restored.placements[0].x + restored.placements[0].width);
});
it('rolls back every edit and child when a source version conflicts', () => {
  const other = createTextBlock(db, actor, brane);
  expect(() =>
    spawn(
      request({
        sourceBlockIds: [block, other.id],
        edits: [
          { blockId: block, text: 'Must roll back', version: 1 },
          { blockId: other.id, text: 'Conflict', version: 4 },
        ],
      }),
    ),
  ).toThrow('changed');
  expect(state().blocks.find((b) => b.id === block)?.content.text).toBe('Original');
  expect(state().runs).toHaveLength(0);
  expect(state().blocks).toHaveLength(2);
});
it('returns the same child on duplicate delivery but allows intentional sibling spawns', () => {
  const input = request({ edits: [{ blockId: block, text: 'Submitted once', version: 1 }] });
  const first = spawn(input);
  expect(spawn(input).id).toBe(first.id);
  expect(state().runs).toHaveLength(1);
  expect(() => spawn({ ...input, edits: [] })).toThrow('different request');
  spawn(request());
  expect(state().runs).toHaveLength(2);
  const outputs = state().placements.filter((p) => p.block_id !== block);
  expect(outputs[0].y).not.toBe(outputs[1].y);
});
it('retries frozen sources and keeps provenance after source placement removal', () => {
  const run = spawn();
  const frozen = readInputs(db, run.id);
  cancelRun(db, actor, run.id);
  updateBlockLiveState(db, actor, { blockId: block, text: 'New content', version: 1 });
  removePlacement(db, actor, placement);
  const retry = retryRun(db, actor, run.id, uid(), limits);
  expect(readInputs(db, retry.id).map((i) => i.revision_id)).toEqual(
    frozen.map((i) => i.revision_id),
  );
  expect(state().derivations).toHaveLength(2);
  expect(derivationEdges(state())).toHaveLength(0);
  createPlacement(db, actor, brane, block);
  expect(derivationEdges(state())).toHaveLength(2);
  expect(db.pragma('foreign_key_check')).toEqual([]);
});
it('uses the clicked instance, and projects links in another brane without changing provenance', () => {
  const second = createPlacement(db, actor, brane, block, {
    x: 900,
    y: 40,
    width: 320,
    height: 220,
  });
  const run = spawn(request({ anchorPlacementId: second.id }));
  expect(derivationEdges(state())[0].source).toBe(second.id);
  const elsewhere = createBrane(db, actor).id;
  createPlacement(db, actor, elsewhere, block);
  createPlacement(db, actor, elsewhere, run.output_block_id);
  expect(derivationEdges(readBrane(db, actor, elsewhere) as BraneState)).toHaveLength(1);
});
it('validates ownership, anchor membership, ready sources and source-only edits', () => {
  const elsewhere = createBrane(db, actor).id;
  const foreignPlacement = createPlacement(db, actor, elsewhere, block);
  expect(() => spawn(request({ anchorPlacementId: foreignPlacement.id }))).toThrow('anchor');
  const page = createBlock(
    db,
    actor,
    'webpage',
    { format: 'webpage', text: '', status: 'pending' },
    brane,
  );
  expect(() =>
    spawn(request({ sourceBlockIds: [page.id], anchorPlacementId: page.placement.id })),
  ).toThrow('not ready');
  expect(schema.safeParse(request({ sourceBlockIds: [block, block] })).success).toBe(false);
  expect(
    schema.safeParse(request({ edits: [{ blockId: uid(), text: '', version: 0 }] })).success,
  ).toBe(false);
  const stranger = uid();
  db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
    stranger,
    'Other',
    `${stranger}@example.com`,
    0,
    0,
  );
  const privateBlock = createTextBlock(db, stranger, createBrane(db, stranger).id);
  expect(() => spawn(request({ sourceBlockIds: [block, privateBlock.id] }))).toThrow();
  expect(state().runs).toHaveLength(0);
});
it('spawns recursively from finalized output without inheriting ancestors, and preserves ordered multiple sources', async () => {
  const first = spawn();
  expect(() =>
    spawn(
      request({
        sourceBlockIds: [first.output_block_id],
        anchorPlacementId: state().placements.find((p) => p.block_id === first.output_block_id)!.id,
      }),
    ),
  ).toThrow('finalized');
  const worker = new RunWorker(
    db,
    new EventHub(),
    async (_request, chunk) => {
      chunk('Child');
      return { text: 'Child' };
    },
    { concurrency: 1, leaseMs: 5000, checkpointMs: 5, checkpointCharacters: 1 },
  );
  await worker.tick();
  await expect.poll(() => state().runs[0].status).toBe('completed');
  const child = state().blocks.find((b) => b.id === first.output_block_id)!;
  expect(child.messageId).toBeTruthy();
  const second = spawn(
    request({
      sourceBlockIds: [child.id, block],
      anchorPlacementId: state().placements.find((p) => p.block_id === child.id)!.id,
    }),
  );
  expect(readInputs(db, second.id).map((i) => i.kind)).toEqual(['source', 'source', 'prompt']);
  expect(readInputs(db, second.id)[0].content.text).toBe('Child');
  expect(
    state()
      .derivations.filter((d) => d.runId === second.id)
      .map((d) => d.sourceBlockId),
  ).toEqual([child.id, block]);
  await worker.stop();
});
