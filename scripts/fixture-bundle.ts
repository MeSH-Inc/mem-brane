// Synthetic fixture for transfer/restore drills; never reads the live database.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openDatabase } from '../server/db/index.js';
import { createBrane, createBlock, revisions, uid } from '../server/services/content.js';
import { FileAssetStore } from '../server/storage/assets.js';
import { createBundle } from '../server/storage/bundle.js';
import { RunWorker } from '../server/jobs/worker.js';
import { submitRun } from '../server/services/runs.js';
import { EventHub } from '../server/sse/hub.js';
if (!process.argv[2])
  throw new Error('Usage: node --import tsx scripts/fixture-bundle.ts /new/bundle-directory');
const directory = await mkdtemp(join(tmpdir(), 'membrane-backup-fixture-'));
const database = join(directory, 'db.sqlite'),
  db = openDatabase(database);
try {
  const actor = uid();
  db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
    actor,
    'Restore fixture',
    'restore-fixture@example.com',
    0,
    0,
  );
  const brane = createBrane(db, actor, 'Restore fixture'),
    asset = uid();
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
    'base64',
  );
  const store = new FileAssetStore(join(directory, 'assets'));
  await store.put(asset, bytes);
  db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?,?)').run(
    asset,
    actor,
    asset,
    'image/png',
    bytes.length,
    0,
    createHash('sha256').update(bytes).digest('hex'),
  );
  const block = createBlock(
    db,
    actor,
    'image',
    {
      format: 'image',
      filename: 'fixture.png',
      text: 'Backup fixture',
      assetId: asset,
      assetHash: createHash('sha256').update(bytes).digest('hex'),
      mimeType: 'image/png',
      representation: 'original-image-v1',
    },
    brane.id,
  );
  const run = submitRun(
    db,
    revisions(db),
    actor,
    {
      braneId: brane.id,
      key: uid(),
      model: 'mock',
      prompt: 'Restore this provenance',
      references: [block.id],
      edits: [],
    },
    { models: ['mock'], maxTokens: 100, userConcurrency: 3, maxContextCharacters: 10000 },
  );
  const worker = new RunWorker(
    db,
    new EventHub(),
    async () => ({ text: 'Verified fixture artifact' }),
    { concurrency: 1, leaseMs: 1000, checkpointMs: 10, checkpointCharacters: 10 },
  );
  worker.tick();
  const deadline = Date.now() + 3000;
  while (
    (db.prepare('SELECT status FROM runs WHERE id=?').get(run.id) as { status: string }).status !==
    'completed'
  ) {
    if (Date.now() > deadline) throw new Error('Fixture worker failed');
    await new Promise((r) => setTimeout(r, 10));
  }
  await worker.stop();
  submitRun(
    db,
    revisions(db),
    actor,
    {
      braneId: brane.id,
      key: uid(),
      model: 'mock',
      prompt: 'Must remain queued during recovery',
      references: [],
      edits: [],
    },
    { models: ['mock'], maxTokens: 100, userConcurrency: 3, maxContextCharacters: 10000 },
  );
  const manifest = await createBundle(database, store, process.argv[2]);
  console.log(JSON.stringify(manifest.checked));
} finally {
  db.close();
  await rm(directory, { recursive: true, force: true });
}
