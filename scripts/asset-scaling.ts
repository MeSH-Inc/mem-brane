// Disposable binary/PDF fixture: measures stored payloads, not process memory or latency.
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { openDatabase } from '../server/db/index.js';
import { createBrane, readBrane, revisions, uid } from '../server/services/content.js';
import { createImports } from '../server/services/imports.js';
import { verifyRestoration } from '../server/storage/verify.js';
import { pdfFixture } from '../tests/fixtures/pdf.js';
import type { AssetStore } from '../server/storage/assets.js';
const copies = 20;
const db = openDatabase(':memory:');
const objects = new Map<string, Uint8Array>();
const store: AssetStore = {
  put: async (key, bytes) => {
    objects.set(key, bytes);
  },
  get: async (key) => objects.get(key)!,
  delete: async (key) => {
    objects.delete(key);
  },
  createReadUrl: async () => '',
};
try {
  const actor = uid();
  db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
    actor,
    'Fixture',
    `${actor}@test`,
    0,
    0,
  );
  const brane = createBrane(db, actor).id;
  const pixels = Buffer.alloc(128 * 96 * 3);
  let seed = 1;
  for (let i = 0; i < pixels.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels[i] = seed >>> 24;
  }
  const png = await sharp(pixels, { raw: { width: 128, height: 96, channels: 3 } })
    .png()
    .toBuffer();
  const pdf = pdfFixture(
    Array.from({ length: 5 }, (_, i) =>
      [
        `Page ${i + 1}:`,
        ...Array.from({ length: 20 }, () => 'Evidence about immutable records. '.repeat(2)),
      ].join('\n'),
    ),
  );
  const fixtures = [
    { name: 'Noise.png', bytes: png },
    { name: 'Evidence.pdf', bytes: pdf },
  ];
  const imports = createImports(db, store);
  let legacyContentBytes = 0,
    legacyResultBytes = 0,
    receiptBytes = 0;
  for (const fixture of fixtures)
    for (let i = 0; i < copies; i++) {
      const receipt = await imports.import(
        actor,
        {
          key: uid(),
          braneId: brane,
          target: 'canvas',
          geometry: { x: 0, y: i * 10, width: 320, height: 300 },
        },
        new File([new Uint8Array(fixture.bytes)], fixture.name),
      );
      const state = readBrane(db, actor, brane),
        block = state.blocks.find((b) => b.id === receipt.blockId)!;
      const expanded = revisions(db).snapshotBlock(actor, block.id).content;
      if (
        expanded.format === 'pdf' &&
        (expanded.representation.status !== 'ready' ||
          expanded.representation.pages.reduce((n, p) => n + p.text.length, 0) < 6000)
      )
        throw new Error('PDF fixture lost evidence');
      legacyContentBytes += 2 * Buffer.byteLength(JSON.stringify(expanded));
      legacyResultBytes += Buffer.byteLength(
        JSON.stringify({
          ...block,
          content: expanded,
          placement: state.placements.find((p) => p.id === receipt.placementId),
        }),
      );
      receiptBytes += Buffer.byteLength(JSON.stringify(receipt));
    }
  const scalar = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const result = {
    method:
      '20 distinct imports per file, one snapshot per artifact; byte totals are UTF-8 logical payloads, not SQLite allocation or memory savings',
    copiesPerFile: copies,
    fixtures: fixtures.map((f) => ({ name: f.name, byteLength: f.bytes.length })),
    counts: {
      assets: scalar('SELECT count(*) n FROM assets'),
      representations: scalar('SELECT count(*) n FROM asset_representations'),
      blocks: scalar('SELECT count(*) n FROM blocks'),
      revisions: scalar('SELECT count(*) n FROM block_revisions'),
      receipts: scalar('SELECT count(*) n FROM artifact_imports'),
    },
    objectBytes: {
      stored: [...objects.values()].reduce((n, b) => n + b.length, 0),
      withoutDedup: fixtures.reduce((n, f) => n + f.bytes.length * copies, 0),
    },
    payloadBytes: {
      legacyExpandedLiveAndRevisions: legacyContentBytes,
      legacyFullImportResults: legacyResultBytes,
      compactLiveAndRevisions: scalar(
        'SELECT sum(length(CAST(content_json AS BLOB))) n FROM (SELECT content_json FROM block_live_state UNION ALL SELECT content_json FROM block_revisions)',
      ),
      representations: scalar(
        'SELECT sum(length(CAST(payload_json AS BLOB))) n FROM asset_representations',
      ),
      wireReceipts: receiptBytes,
    },
    restore: await verifyRestoration(db, store),
  };
  if (
    result.counts.assets !== 2 ||
    result.counts.representations !== 2 ||
    result.restore.references !== 80
  )
    throw new Error('Asset scaling invariant failed');
  const output = JSON.stringify(result, null, 2) + '\n';
  if (process.argv[2]) await writeFile(process.argv[2], output);
  else process.stdout.write(output);
} finally {
  db.close();
}
