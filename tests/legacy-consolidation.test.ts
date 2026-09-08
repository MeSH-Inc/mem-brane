import { createBundle, verifyBundle } from '../server/storage/bundle';
import { reserveUpload } from '../server/services/capacity';
import Database from 'better-sqlite3';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  cpSync,
  existsSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { it, expect } from 'vitest';
import { openDatabase } from '../server/db';
import { readRevision, uid } from '../server/services/content';
import { FileAssetStore } from '../server/storage/assets';
import { verifyRestoration } from '../server/storage/verify';
import {
  planLegacyConsolidation,
  consolidateLegacyAssets,
  verifyLegacyBackup,
  cleanupConsolidatedAssets,
} from '../server/storage/legacy-consolidation';
import { pdfFixture } from './fixtures/pdf';
import { inspectPdf } from '../server/ingestion/pdf';
import { buildMessages } from '../server/llm/model';
import { resolveMessages } from '../server/llm/assets';
import type { Content, RunInput } from '../shared/types/domain';
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'membrane-consolidation-')),
    path = join(directory, 'db.sqlite'),
    db = new Database(path),
    store = new FileAssetStore(join(directory, 'objects'));
  db.exec('CREATE TABLE schema_migrations(name TEXT PRIMARY KEY)');
  for (const name of readdirSync('migrations')
    .filter((n) => n.endsWith('.sql') && n < '015-')
    .sort()) {
    db.exec(readFileSync(join('migrations', name), 'utf8'));
    db.prepare('INSERT INTO schema_migrations VALUES (?)').run(name);
  }
  db.pragma('foreign_keys=ON');
  const actor = uid(),
    other = uid(),
    brane = uid(),
    otherBrane = uid();
  for (const [owner, b] of [
    [actor, brane],
    [other, otherBrane],
  ]) {
    db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
      owner,
      'Owner',
      `${owner}@test`,
      0,
      0,
    );
    db.prepare('INSERT INTO branes VALUES (?,?,?,?,?)').run(b, owner, 'B', 0, 0);
  }
  const bytes = pdfFixture(['Unchanged frozen evidence']),
    digest = createHash('sha256').update(bytes).digest('hex'),
    extracted = await inspectPdf(bytes);
  const ids = [1, 2, 3].map((n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`),
    blocks: string[] = [],
    contents: Content[] = [];
  for (const [index, id] of ids.entries()) {
    const owner = index === 2 ? other : actor,
      b = index === 2 ? otherBrane : brane,
      block = uid(),
      placement = uid();
    blocks.push(block);
    await store.put(id, bytes);
    db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,0)').run(
      id,
      owner,
      id,
      'application/pdf',
      bytes.length,
    );
    const content: Content = {
      format: 'pdf',
      text: 'Paper',
      filename: 'Paper.pdf',
      assetId: id,
      assetHash: digest,
      mimeType: 'application/pdf',
      ...extracted,
    };
    contents.push(content);
    db.prepare("INSERT INTO blocks VALUES (?,?,'pdf',0,'authored')").run(block, owner);
    db.prepare('INSERT INTO block_live_state VALUES (?,?,0,0)').run(block, JSON.stringify(content));
    db.prepare(
      'INSERT INTO block_revisions (id,block_id,content_json,created_at,source_version) VALUES (?,?,?,0,0)',
    ).run(block, block, JSON.stringify(content));
    db.prepare(
      'INSERT INTO placements (id,brane_id,block_id,x,y,width,height,z_index,updated_at) VALUES (?,?,?,123,456,320,300,0,0)',
    ).run(placement, b, block);
    db.prepare("INSERT INTO artifact_imports VALUES (?,?,?,?,?,'ready',?,0)").run(
      owner,
      uid(),
      'same-request-hash',
      id,
      b,
      JSON.stringify({ id: block, content, placement: { id: placement } }),
    );
  }
  return {
    directory,
    path,
    db,
    store,
    actor,
    ids,
    blocks,
    contents,
    bytes,
    backup: join(directory, 'backup'),
  };
}
const inputs = (id: string, content: Content): RunInput[] => [
  { position: 0, kind: 'reference', label: 'Paper', role: 'user', revision_id: id, content },
];
it('consolidates deterministically within owners, preserves provider messages, and restores the verified original backup', async () => {
  const f = await fixture();
  let db = f.db;
  try {
    const plan = await planLegacyConsolidation(db, f.store);
    expect(await planLegacyConsolidation(db, f.store)).toEqual(plan);
    expect(plan.redundantObjects).toBe(1);
    expect(plan.assets.map((a) => a.canonicalId)).toEqual(
      expect.arrayContaining([f.ids[0], f.ids[0], f.ids[2]]),
    );
    const before = buildMessages(inputs(f.blocks[1], f.contents[1]));
    await consolidateLegacyAssets(db, f.store, f.backup);
    expect(await verifyLegacyBackup(f.backup)).toEqual(plan);
    expect(existsSync(join(f.directory, 'objects', f.ids[1]))).toBe(true);
    db.close();
    db = openDatabase(f.path);
    expect(() =>
      reserveUpload(db, f.actor, uid(), 1, {
        userBytes: 2 * f.bytes.length,
        totalBytes: 3 * f.bytes.length,
      }),
    ).toThrow('capacity');
    const content = readRevision(db, f.actor, f.blocks[1]).content;
    expect(content.assetId).toBe(f.ids[0]);
    expect(await resolveMessages(db, f.store, f.actor, inputs(f.blocks[1], content))).toEqual(
      before,
    );
    expect(await verifyRestoration(db, f.store)).toMatchObject({ assets: 2, references: 6 });
    expect(await cleanupConsolidatedAssets(db, f.store, f.backup)).toEqual({ deleted: 1 });
    expect(existsSync(join(f.directory, 'objects', f.ids[1]))).toBe(false);
    expect(await cleanupConsolidatedAssets(db, f.store, f.backup)).toEqual({ deleted: 0 });
    // Restore the actual backup, then repeat consolidation and the normal migration.
    const restoredPath = join(f.directory, 'restored.sqlite'),
      restoredObjects = join(f.directory, 'restored-objects');
    cpSync(join(f.backup, 'db.sqlite'), restoredPath);
    cpSync(join(f.backup, 'assets'), restoredObjects, { recursive: true });
    let restored = new Database(restoredPath);
    const restoredStore = new FileAssetStore(restoredObjects);
    try {
      expect(await planLegacyConsolidation(restored, restoredStore)).toEqual(plan);
      await consolidateLegacyAssets(restored, restoredStore, join(f.directory, 'restored-backup'));
      restored.close();
      restored = openDatabase(restoredPath);
      expect(await verifyRestoration(restored, restoredStore)).toMatchObject({
        assets: 2,
        references: 6,
      });
      expect(
        buildMessages(inputs(f.blocks[1], readRevision(restored, f.actor, f.blocks[1]).content)),
      ).toEqual(before);
    } finally {
      restored.close();
    }
  } finally {
    db.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});
it('rolls back before commit and reuses the verified backup on retry', async () => {
  const f = await fixture();
  try {
    const before = await planLegacyConsolidation(f.db, f.store);
    await expect(
      consolidateLegacyAssets(f.db, f.store, f.backup, () => {
        throw new Error('crash');
      }),
    ).rejects.toThrow('crash');
    expect(await planLegacyConsolidation(f.db, f.store)).toEqual(before);
    expect(
      f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='asset_consolidation_journal'").get(),
    ).toBeUndefined();
    await consolidateLegacyAssets(f.db, f.store, f.backup);
    expect(f.db.prepare('SELECT count(*) n FROM assets').get()).toEqual({ n: 2 });
  } finally {
    f.db.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});
it('recovers after metadata commit and an unacknowledged object deletion', async () => {
  const f = await fixture();
  let db = f.db;
  try {
    await expect(
      consolidateLegacyAssets(db, f.store, f.backup, (stage) => {
        if (stage === 'afterCommit') throw new Error('crash');
      }),
    ).rejects.toThrow('crash');
    db.close();
    db = openDatabase(f.path);
    await expect(
      cleanupConsolidatedAssets(db, f.store, f.backup, () => {
        throw new Error('lost delete acknowledgement');
      }),
    ).rejects.toThrow('acknowledgement');
    expect(db.prepare('SELECT state FROM asset_consolidation_journal').get()).toEqual({
      state: 'deleting',
    });
    expect((await verifyRestoration(db, f.store)).cleanup.requiredBackups[0]).toMatchObject({
      awaitingDeletion: 0,
      unacknowledgedDeletion: 1,
    });
    expect(await cleanupConsolidatedAssets(db, f.store, f.backup)).toEqual({ deleted: 1 });
    expect(await verifyRestoration(db, f.store)).toMatchObject({ assets: 2 });
  } finally {
    db.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});
it.each(['original', 'backup', 'canonical'])(
  'refuses %s corruption before destructive work',
  async (kind) => {
    const f = await fixture();
    let db = f.db;
    try {
      if (kind === 'original') {
        writeFileSync(join(f.directory, 'objects', f.ids[1]), Buffer.alloc(f.bytes.length));
        await expect(consolidateLegacyAssets(db, f.store, f.backup)).rejects.toThrow('integrity');
        expect(db.prepare('SELECT count(*) n FROM assets').get()).toEqual({ n: 3 });
      } else {
        await consolidateLegacyAssets(db, f.store, f.backup);
        db.close();
        db = openDatabase(f.path);
        const target =
          kind === 'backup'
            ? join(f.backup, 'assets', f.ids[0])
            : join(f.directory, 'objects', f.ids[0]);
        writeFileSync(target, Buffer.alloc(f.bytes.length));
        await expect(cleanupConsolidatedAssets(db, f.store, f.backup)).rejects.toThrow(
          /integrity/i,
        );
        expect(existsSync(join(f.directory, 'objects', f.ids[1]))).toBe(true);
      }
    } finally {
      db.close();
      rmSync(f.directory, { recursive: true, force: true });
    }
  },
);

it('clears obsolete cleanup reservations after restoring a canonical-only bundle', async () => {
  const f = await fixture();
  let db = f.db;
  try {
    await consolidateLegacyAssets(db, f.store, f.backup);
    db.close();
    db = openDatabase(f.path);
    const bundle = join(f.directory, 'canonical-bundle');
    await createBundle(f.path, f.store, bundle);
    const verified = await verifyBundle(bundle);
    expect(verified).toMatchObject({
      assets: 2,
      references: 6,
      objectCoverage: 'canonical-assets-only',
      cleanup: {
        objects: 1,
        reservedBytes: f.bytes.length,
        requiredBackups: [
          {
            objects: 1,
            reservedBytes: f.bytes.length,
            awaitingDeletion: 1,
            unacknowledgedDeletion: 0,
          },
        ],
      },
    });
    expect(verified.cleanup.requiredBackups[0].backupFingerprint).toBe(
      (await verifyLegacyBackup(f.backup)).fingerprint,
    );
    expect(verified.cleanup.nextAction).toContain('original legacy backup');
    const restoredPath = join(f.directory, 'canonical-restored.sqlite');
    cpSync(join(bundle, 'db.sqlite'), restoredPath);
    const restored = openDatabase(restoredPath);
    try {
      expect(
        await cleanupConsolidatedAssets(
          restored,
          new FileAssetStore(join(bundle, 'assets')),
          f.backup,
        ),
      ).toEqual({ deleted: 1 });
      expect(restored.prepare('SELECT state FROM asset_consolidation_journal').get()).toEqual({
        state: 'deleted',
      });
      expect(
        (await verifyRestoration(restored, new FileAssetStore(join(bundle, 'assets')))).cleanup,
      ).toMatchObject({ objects: 0, reservedBytes: 0, requiredBackups: [] });
      // Restored cleanup did not touch the separate source object directory.
      expect(existsSync(join(f.directory, 'objects', f.ids[1]))).toBe(true);
    } finally {
      restored.close();
    }
  } finally {
    db.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});
