import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openDatabase, type DB } from '../server/db';
import {
  createBlock,
  createBrane,
  createPlacement,
  createTextBlock,
  readBrane,
  removePlacement,
  revisions,
  uid,
  updateBlockLiveState,
} from '../server/services/content';
import { readCard, readUnplacedCards } from '../server/services/card-library';
import { submitRun } from '../server/services/runs';
import { RunWorker } from '../server/jobs/worker';
import { EventHub } from '../server/sse/hub';
import { blockResponse, unplacedPageResponse } from '../shared/contracts';
import { createImports } from '../server/services/imports';
import { pdfFixture } from './fixtures/pdf';
import sharp from 'sharp';

let db: DB, actor: string, brane: string;
beforeEach(() => {
  db = openDatabase(':memory:');
  actor = uid();
  db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
    actor,
    'Cards',
    `${actor}@example.com`,
    0,
    0,
  );
  brane = createBrane(db, actor).id;
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

it('keeps a card placed until its last instance anywhere is removed and restores its identity and history', () => {
  const block = createTextBlock(db, actor, brane);
  updateBlockLiveState(db, actor, { blockId: block.id, text: 'Keep this thought', version: 0 });
  const revision = revisions(db).snapshotBlock(actor, block.id);
  const duplicate = createPlacement(db, actor, brane, block.id);
  const otherBrane = createBrane(db, actor).id;
  const elsewhere = createPlacement(db, actor, otherBrane, block.id);
  removePlacement(db, actor, block.placement.id);
  removePlacement(db, actor, duplicate.id);
  expect(readUnplacedCards(db, actor).items).toEqual([]);
  removePlacement(db, actor, elsewhere.id);
  expect(unplacedPageResponse.parse(readUnplacedCards(db, actor)).items).toMatchObject([
    { id: block.id, preview: 'Keep this thought' },
  ]);
  expect(blockResponse.parse(readCard(db, actor, block.id))).toMatchObject({
    id: block.id,
    content: { text: 'Keep this thought' },
    version: 1,
  });
  createPlacement(db, actor, brane, block.id);
  expect(readUnplacedCards(db, actor).items).toEqual([]);
  expect(readBrane(db, actor, brane).blocks).toMatchObject([{ id: block.id, version: 1 }]);
  expect(revisions(db).snapshotBlock(actor, block.id).id).toBe(revision.id);
});

it('pages bounded summaries across timestamp ties and excludes other libraries and already placed cards', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const ids = Array.from(
    { length: 7 },
    (_, i) =>
      createBlock(db, actor, 'text', { format: 'text', text: `${i}:` + 'x'.repeat(300) }).id,
  )
    .sort()
    .reverse();
  createTextBlock(db, actor, brane);
  const first = readUnplacedCards(db, actor, 3);
  expect(first.items.every((item) => item.preview.length === 160)).toBe(true);
  // Replacing the cursor card between pages must not invalidate continuation.
  createPlacement(db, actor, brane, first.nextCursor!);
  const second = readUnplacedCards(db, actor, 3, first.nextCursor!);
  const third = readUnplacedCards(db, actor, 3, second.nextCursor!);
  expect([...first.items, ...second.items, ...third.items].map((item) => item.id)).toEqual(ids);
  expect(third.nextCursor).toBeNull();
  expect(readUnplacedCards(db, uid()).items).toEqual([]);
  expect(() => readCard(db, uid(), ids[0])).toThrow('not found');
  expect(() => readUnplacedCards(db, uid(), 3, ids[0])).toThrow('Invalid card cursor');
  expect(() => readUnplacedCards(db, actor, 51)).toThrow('1..50');
});

it('previews removed generated output and restores provenance while hiding internal prompt blocks', async () => {
  const source = createTextBlock(db, actor, brane);
  const run = submitRun(
    db,
    revisions(db),
    actor,
    {
      braneId: brane,
      key: uid(),
      model: 'mock',
      prompt: 'Internal prompt',
      references: [source.id],
      edits: [],
    },
    { models: ['mock'], maxTokens: 100, userConcurrency: 3, maxContextCharacters: 10000 },
  );
  const worker = new RunWorker(db, new EventHub(), async () => ({ text: 'Saved answer' }), {
    concurrency: 1,
    leaseMs: 5000,
    checkpointMs: 20,
    checkpointCharacters: 1,
  });
  try {
    worker.tick();
    await expect
      .poll(
        () =>
          (db.prepare('SELECT status FROM runs WHERE id=?').get(run.id) as { status: string })
            .status,
      )
      .toBe('completed');
  } finally {
    await worker.stop();
  }
  const state = readBrane(db, actor, brane);
  const original = state.blocks.find((block) => block.id === run.output_block_id)!;
  removePlacement(db, actor, state.placements.find((p) => p.block_id === original.id)!.id);
  expect(readUnplacedCards(db, actor).items).toMatchObject([
    { id: original.id, preview: 'Saved answer' },
  ]);
  expect(readCard(db, actor, original.id)).toEqual(original);
  const prompt = db
    .prepare(
      "SELECT v.block_id FROM context_entries e JOIN block_revisions v ON v.id=e.revision_id WHERE e.context_id=? AND e.kind='prompt'",
    )
    .get(run.context_id) as { block_id: string };
  expect(() => readCard(db, actor, prompt.block_id)).toThrow('not found');
  createPlacement(db, actor, brane, original.id);
  expect(readBrane(db, actor, brane).derivations).toMatchObject([
    { runId: run.id, sourceBlockId: source.id, outputBlockId: original.id },
  ]);
  expect(readBrane(db, actor, brane).blocks.find((b) => b.id === original.id)?.messageId).toBe(
    original.messageId,
  );
});

it('restores image and PDF cards without copying bytes, representations or frozen revisions', async () => {
  const bytes = new Map<string, Uint8Array>();
  const imports = createImports(db, {
    put: async (key, value) => {
      bytes.set(key, value);
    },
    get: async (key) => bytes.get(key)!,
    delete: async (key) => {
      bytes.delete(key);
    },
    createReadUrl: async () => '',
  });
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
  for (const file of [
    new File([new Uint8Array(png)], 'map.png', { type: 'image/png' }),
    new File([new Uint8Array(pdfFixture(['Original survey']))], 'survey.pdf', {
      type: 'application/pdf',
    }),
  ]) {
    const receipt = await imports.import(
      actor,
      {
        key: uid(),
        braneId: brane,
        target: 'canvas',
        geometry: { x: 0, y: 0, width: 320, height: 240 },
      },
      file,
    );
    const original = readCard(db, actor, receipt.blockId);
    const revision = revisions(db).snapshotBlock(actor, receipt.blockId);
    removePlacement(db, actor, receipt.placementId);
    expect(readUnplacedCards(db, actor).items.map((card) => card.id)).toContain(receipt.blockId);
    expect(blockResponse.parse(readCard(db, actor, receipt.blockId))).toEqual(original);
    createPlacement(db, actor, brane, receipt.blockId);
    expect(readBrane(db, actor, brane).blocks.find((b) => b.id === receipt.blockId)).toEqual(
      original,
    );
    expect(revisions(db).snapshotBlock(actor, receipt.blockId)).toEqual(revision);
  }
  expect(bytes.size).toBe(2);
  expect(db.prepare('SELECT count(*) n FROM assets').get()).toEqual({ n: 2 });
});
