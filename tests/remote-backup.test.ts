import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openDatabase } from '../server/db';
import { FileAssetStore } from '../server/storage/assets';
import { backupToRemote, type BackupDestination } from '../server/storage/remote-backup';
import { verifyBundle } from '../server/storage/bundle';
it('publishes a restorable archive, commits only after readback, and prunes only expired owned backups', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-backup-test-'));
  const database = join(directory, 'source.sqlite');
  openDatabase(database).close();
  const objects = new Map<string, Buffer>([
    ['mem-brane/production/2026-08-01.tar.gz', Buffer.from('old')],
    ['mem-brane/production/2026-09-11.tar.gz', Buffer.from('recent')],
    ['unrelated/archive.tar.gz', Buffer.from('protected')],
  ]);
  const complete = new Set<string>();
  const remote: BackupDestination = {
    async exists(key) {
      return complete.has(key);
    },
    async upload(key, path) {
      objects.set(key, await readFile(path));
    },
    async checksum(key) {
      return createHash('sha256').update(objects.get(key)!).digest('hex');
    },
    async complete(key) {
      complete.add(key);
    },
    async keys() {
      return [...objects.keys()];
    },
    async remove(key) {
      objects.delete(key);
      complete.delete(key);
    },
  };
  try {
    const result = await backupToRemote(
      database,
      new FileAssetStore('unused'),
      remote,
      new Date('2026-09-12T12:00:00Z'),
    );
    expect(result.status).toBe('created');
    expect(complete.has(result.key)).toBe(true);
    expect(objects.has('mem-brane/production/2026-08-01.tar.gz')).toBe(false);
    expect(objects.has('mem-brane/production/2026-09-11.tar.gz')).toBe(true);
    expect(objects.has('unrelated/archive.tar.gz')).toBe(true);
    const archive = join(directory, 'download.tar.gz');
    await writeFile(archive, objects.get(result.key)!);
    await mkdir(join(directory, 'restore'));
    await promisify(execFile)('tar', ['-xzf', archive, '-C', join(directory, 'restore')]);
    expect(await verifyBundle(join(directory, 'restore'))).toMatchObject({ assets: 0 });
    expect(
      (
        await backupToRemote(
          database,
          new FileAssetStore('unused'),
          remote,
          new Date('2026-09-12T16:00:00Z'),
        )
      ).status,
    ).toBe('current');
    objects.set('mem-brane/production/2026-08-02.tar.gz', Buffer.from('old preserved on failure'));
    remote.checksum = async () => 'corrupted';
    await expect(
      backupToRemote(
        database,
        new FileAssetStore('unused'),
        remote,
        new Date('2026-09-13T12:00:00Z'),
      ),
    ).rejects.toThrow('checksum mismatch');
    expect(complete.has('mem-brane/production/2026-09-13.tar.gz')).toBe(false);
    expect(objects.has('mem-brane/production/2026-08-02.tar.gz')).toBe(true);
    expect(objects.has('mem-brane/production/2026-09-13.tar.gz')).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
