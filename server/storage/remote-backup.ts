import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createBundle } from './bundle.js';
import type { AssetStore } from './assets.js';
export interface BackupDestination {
  exists(key: string): Promise<boolean>;
  upload(key: string, path: string, size: number): Promise<void>;
  checksum(key: string): Promise<string>;
  complete(key: string, checksum: string): Promise<void>;
  keys(): Promise<string[]>;
  remove(key: string): Promise<void>;
}
export const backupPrefix = 'mem-brane/production/';
const ownedKey = /^mem-brane\/production\/(\d{4}-\d{2}-\d{2})(?:-[a-f0-9-]{36})?\.tar\.gz$/;
export async function backupToRemote(
  database: string,
  assets: Pick<AssetStore, 'get'>,
  destination: BackupDestination,
  now = new Date(),
  force = false,
) {
  const day = now.toISOString().slice(0, 10);
  const key = `${backupPrefix}${day}${force ? `-${randomUUID()}` : ''}.tar.gz`;
  if (await destination.exists(key)) return { status: 'current' as const, key };
  const directory = await mkdtemp(join(tmpdir(), 'mem-brane-backup-'));
  try {
    const manifest = await createBundle(database, assets, join(directory, 'bundle'));
    const archive = join(directory, 'bundle.tar.gz');
    await promisify(execFile)('tar', ['-czf', archive, '-C', join(directory, 'bundle'), '.'], {
      timeout: 120000,
    });
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(archive)) digest.update(chunk);
    const checksum = digest.digest('hex');
    const size = (await stat(archive)).size;
    await destination.upload(key, archive, size);
    if ((await destination.checksum(key)) !== checksum) {
      // Do not let an incomplete daily object suppress the next retry.
      await destination.remove(key);
      throw new Error('Remote backup checksum mismatch');
    }
    await destination.complete(key, checksum);
    // Only expire our dated objects after a new backup has been read back successfully.
    const cutoff = now.getTime() - 14 * 86400000;
    for (const candidate of await destination.keys()) {
      const match = ownedKey.exec(candidate);
      if (candidate !== key && match && Date.parse(`${match[1]}T00:00:00Z`) < cutoff)
        await destination.remove(candidate);
    }
    return { status: 'created' as const, key, size, checksum, checked: manifest.checked };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
