import { policyIdentity } from '../ingestion/policy.js';
import { decodeContent } from '../services/representations.js';
import { representationId } from '../domain/canonical.js';
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
  for (const row of db.prepare('SELECT * FROM asset_representations').iterate() as Iterable<{
    id: string;
    asset_id: string;
    format: string;
    payload_json: string;
  }>) {
    if (row.id !== representationId(row.asset_id, row.format, row.payload_json))
      throw new Error(`Representation integrity mismatch: ${row.id}`);
  }
  if (
    db
      .prepare(
        `SELECT 1 FROM (
    SELECT block_id,representation_id FROM block_live_state UNION ALL SELECT block_id,representation_id FROM block_revisions
  ) c JOIN blocks b ON b.id=c.block_id JOIN asset_representations r ON r.id=c.representation_id
  JOIN assets a ON a.id=r.asset_id WHERE a.owner_id!=b.owner_id OR r.format!=b.kind LIMIT 1`,
      )
      .get()
  )
    throw new Error('Representation ownership or format mismatch');
  for (const row of db
    .prepare('SELECT id,policy_json FROM extraction_policies')
    .iterate() as Iterable<{ id: string; policy_json: string }>)
    if (policyIdentity(JSON.parse(row.policy_json)).id !== row.id)
      throw new Error('Extraction policy integrity mismatch');
  if (
    db
      .prepare(
        `SELECT 1 FROM extraction_results e JOIN asset_representations r ON r.id=e.representation_id
    WHERE e.asset_id!=r.asset_id OR e.policy_id IS NOT json_extract(r.payload_json,'$.extractionPolicy') LIMIT 1`,
      )
      .get()
  )
    throw new Error('Extraction result integrity mismatch');
  let references = 0;
  for (const row of db
    .prepare(
      'SELECT content_json FROM block_live_state UNION ALL SELECT content_json FROM block_revisions',
    )
    .iterate() as Iterable<{ content_json: string }>) {
    const content = decodeContent(db, row.content_json);
    if (!content.assetId) continue;
    if (!content.assetHash || hashes.get(content.assetId) !== content.assetHash)
      throw new Error(`Asset integrity mismatch: ${content.assetId}`);
    references++;
  }
  const pending = (db.prepare('SELECT count(*) n FROM upload_intents').get() as { n: number }).n;
  return { assets: assets.length, references, pendingUploads: pending };
}
