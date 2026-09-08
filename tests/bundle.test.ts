import { it, expect } from 'vitest';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../server/db';
import { createBundle, verifyBundle } from '../server/storage/bundle';
import { FileAssetStore } from '../server/storage/assets';
it('publishes verified bundles without overwrites and rejects corruption or path escapes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'membrane-bundle-test-'));
  const database = join(directory, 'source.sqlite'),
    db = openDatabase(database);
  db.close();
  const bundle = join(directory, 'bundle');
  try {
    await createBundle(database, new FileAssetStore(join(directory, 'assets')), bundle);
    expect(await verifyBundle(bundle)).toMatchObject({ assets: 0, pendingUploads: 0 });
    await expect(createBundle(database, new FileAssetStore('unused'), bundle)).rejects.toThrow();
    await writeFile(
      join(bundle, 'manifest.json'),
      JSON.stringify({ version: 1, files: { 'db.sqlite': 'wrong' } }),
    );
    await expect(verifyBundle(bundle)).rejects.toThrow('checksum mismatch');
    await writeFile(
      join(bundle, 'manifest.json'),
      JSON.stringify({ version: 1, files: { 'db.sqlite': 'wrong', '../outside': 'x' } }),
    );
    await expect(verifyBundle(bundle)).rejects.toThrow();
    await rm(join(bundle, 'db.sqlite'));
    await symlink(database, join(bundle, 'db.sqlite'));
    await expect(verifyBundle(bundle)).rejects.toThrow('Unsafe backup file');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
