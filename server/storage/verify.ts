import { createHash } from 'node:crypto';
import type { DB } from '../db/index.js';
import type { AssetStore } from './assets.js';
// Run against an isolated, read-only restored database and its matching asset store.
export async function verifyRestoration(db: DB, store: Pick<AssetStore, 'get'>) {
  if (
    db.pragma('integrity_check', { simple: true }) !== 'ok' ||
    (db.pragma('foreign_key_check') as unknown[]).length
  )
    throw new Error('Restored database integrity check failed');
  const assets = db.prepare('SELECT id,storage_key,size,digest FROM assets').all() as {
    id: string;
    storage_key: string;
    size: number;
    digest: string;
  }[];
  const hashes = new Map<string, string>();
  for (const asset of assets) {
    const bytes = await store.get(asset.storage_key, AbortSignal.timeout(30000));
    if (bytes.length !== asset.size) throw new Error(`Asset size mismatch: ${asset.id}`);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== asset.digest) throw new Error(`Asset integrity mismatch: ${asset.id}`);
    hashes.set(asset.id, digest);
  }
  let references = 0;
  for (const row of db
    .prepare(
      'SELECT content_json FROM block_live_state UNION ALL SELECT content_json FROM block_revisions',
    )
    .iterate() as Iterable<{ content_json: string }>) {
    const content = JSON.parse(row.content_json);
    if (!content.assetId) continue;
    if (!content.assetHash || hashes.get(content.assetId) !== content.assetHash)
      throw new Error(`Asset integrity mismatch: ${content.assetId}`);
    references++;
  }
  const pending = (db.prepare('SELECT count(*) n FROM upload_intents').get() as { n: number }).n;
  return { assets: assets.length, references, pendingUploads: pending };
}
