import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, cpSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { openDatabase } from '../server/db';
import { createBrane, createBlock, revisions, uid } from '../server/services/content';
import { reserveUpload, admitImport } from '../server/services/capacity';
import { FileAssetStore } from '../server/storage/assets';
import { verifyRestoration } from '../server/storage/verify';
function fixture() {
  const db = openDatabase(':memory:');
  const actor = uid();
  db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
    actor,
    'Test',
    `${actor}@example.com`,
    0,
    0,
  );
  return { db, actor };
}
it('counts outstanding upload reservations and rejects quota overflow atomically', () => {
  const { db, actor } = fixture();
  try {
    reserveUpload(db, actor, uid(), 6, { userBytes: 10, totalBytes: 10 });
    expect(() => reserveUpload(db, actor, uid(), 5, { userBytes: 10, totalBytes: 10 })).toThrow(
      'capacity',
    );
    expect((db.prepare('SELECT count(*) n FROM upload_intents').get() as any).n).toBe(1);
    expect(() => reserveUpload(db, actor, uid(), 5, { userBytes: 100, totalBytes: 10 })).toThrow(
      'capacity',
    );
  } finally {
    db.close();
  }
});
it('limits imports by actor and globally before admitting more work', () => {
  const { db, actor } = fixture();
  try {
    const block = createBlock(db, actor, 'webpage', {
      text: '',
      url: 'https://example.com',
      status: 'pending',
    });
    db.prepare("INSERT INTO ingestions VALUES (?,'queued',NULL,0)").run(block.id);
    expect(() => admitImport(db, actor, 1, 10)).toThrow('capacity');
    expect(() => admitImport(db, uid(), 10, 1)).toThrow('capacity');
    db.prepare("UPDATE ingestions SET status='failed'").run();
    expect(() => admitImport(db, actor, 1, 1)).not.toThrow();
  } finally {
    db.close();
  }
});
it('restores an online backup with image bytes and detects missing or corrupted assets', async () => {
  const { db, actor } = fixture();
  const directory = mkdtempSync(join(tmpdir(), 'membrane-restore-'));
  const live = join(directory, 'live'),
    restored = join(directory, 'restored');
  mkdirSync(live);
  mkdirSync(restored);
  try {
    const asset = uid(),
      bytes = Buffer.from('frozen test image bytes');
    const store = new FileAssetStore(live);
    await store.put(asset, bytes);
    db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?)').run(
      asset,
      actor,
      asset,
      'image/png',
      bytes.length,
      0,
    );
    const block = createBlock(
      db,
      actor,
      'image',
      {
        text: 'image',
        assetId: asset,
        assetHash: createHash('sha256').update(bytes).digest('hex'),
      },
      createBrane(db, actor).id,
    );
    revisions(db).snapshotBlock(actor, block.id);
    const backup = join(directory, 'restore.sqlite');
    await db.backup(backup);
    cpSync(live, restored, { recursive: true });
    rmSync(live, { recursive: true });
    const copy = new Database(backup, { readonly: true });
    try {
      expect(await verifyRestoration(copy, new FileAssetStore(restored))).toMatchObject({
        assets: 1,
        references: 2,
        pendingUploads: 0,
      });
      writeFileSync(join(restored, asset), Buffer.alloc(bytes.length));
      await expect(verifyRestoration(copy, new FileAssetStore(restored))).rejects.toThrow(
        'integrity mismatch',
      );
      unlinkSync(join(restored, asset));
      await expect(verifyRestoration(copy, new FileAssetStore(restored))).rejects.toThrow();
    } finally {
      copy.close();
    }
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
