import Database from 'better-sqlite3';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile, readFile, rename, realpath, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { AssetStore } from './assets.js';
import { FileAssetStore } from './assets.js';
import { verifyRestoration } from './verify.js';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fileHash(path: string) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
export async function createBundle(
  database: string,
  store: Pick<AssetStore, 'get'>,
  destination: string,
) {
  await mkdir(destination, { mode: 0o700 }); // Never overwrite an existing backup.
  await mkdir(join(destination, 'assets'), { mode: 0o700 });
  const source = new Database(database, { readonly: true, fileMustExist: true });
  try {
    await source.backup(join(destination, 'db.sqlite'));
  } finally {
    source.close();
  }
  const snapshot = new Database(join(destination, 'db.sqlite'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const files: Record<string, string> = {
      'db.sqlite': await fileHash(join(destination, 'db.sqlite')),
    };
    for (const row of snapshot
      .prepare('SELECT storage_key FROM assets ORDER BY storage_key')
      .all() as { storage_key: string }[]) {
      if (!/^[a-f0-9-]{36}$/.test(row.storage_key))
        throw new Error('Invalid asset key in snapshot');
      const bytes = await store.get(row.storage_key, AbortSignal.timeout(30000));
      await writeFile(join(destination, 'assets', row.storage_key), bytes, {
        flag: 'wx',
        mode: 0o600,
      });
      files[`assets/${row.storage_key}`] = hash(bytes);
    }
    const checked = await verifyRestoration(
      snapshot,
      new FileAssetStore(join(destination, 'assets')),
    );
    const manifest = { version: 1, createdAt: new Date().toISOString(), files, checked };
    await writeFile(
      join(destination, 'manifest.pending.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    await rename(join(destination, 'manifest.pending.json'), join(destination, 'manifest.json'));
    return manifest;
  } finally {
    snapshot.close();
  }
}
export async function verifyBundle(directory: string) {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  if (
    manifest.version !== 1 ||
    !manifest.files ||
    typeof manifest.files !== 'object' ||
    Array.isArray(manifest.files) ||
    !Object.hasOwn(manifest.files, 'db.sqlite')
  )
    throw new Error('Invalid backup manifest');
  for (const [path, expected] of Object.entries(manifest.files)) {
    if (path !== 'db.sqlite' && !/^assets\/[a-f0-9-]{36}$/.test(path))
      throw new Error('Invalid manifest path');
    const file = join(directory, path);
    if (
      !(await lstat(file)).isFile() ||
      !(await realpath(file)).startsWith((await realpath(directory)) + '/')
    )
      throw new Error('Unsafe backup file');
    if ((await fileHash(file)) !== expected) throw new Error(`Backup checksum mismatch: ${path}`);
  }
  const db = new Database(join(directory, 'db.sqlite'), { readonly: true, fileMustExist: true });
  try {
    for (const row of db.prepare('SELECT storage_key FROM assets').all() as {
      storage_key: string;
    }[]) {
      if (!Object.hasOwn(manifest.files, `assets/${row.storage_key}`))
        throw new Error('Asset omitted from backup manifest');
    }
    return await verifyRestoration(db, new FileAssetStore(join(directory, 'assets')));
  } finally {
    db.close();
  }
}
