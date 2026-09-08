// Offline tooling for the schema immediately before canonical assets (migration 015).
import Database from 'better-sqlite3';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DB } from '../db/index.js';
import { canonicalJson } from '../domain/canonical.js';
import { FileAssetStore, type AssetStore } from './assets.js';
import { verifyRestoration } from './verify.js';
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
async function fileHash(path: string) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
export interface LegacyAsset {
  id: string;
  owner_id: string;
  storage_key: string;
  mime: string;
  size: number;
  digest: string;
  canonicalId: string;
}
export interface ConsolidationPlan {
  version: 1;
  fingerprint: string;
  assets: LegacyAsset[];
  redundantObjects: number;
  redundantBytes: number;
}
function fingerprint(db: DB) {
  const digest = createHash('sha256');
  for (const row of db
    .prepare(
      "SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='asset_consolidation_journal' ORDER BY name",
    )
    .all() as { name: string; sql: string }[]) {
    digest.update(row.sql);
    for (const item of db.prepare(`SELECT * FROM ${quote(row.name)} ORDER BY rowid`).iterate())
      digest.update(canonicalJson(item));
  }
  return digest.digest('hex');
}
function legacyOnly(db: DB) {
  if (
    !db.prepare("SELECT 1 FROM schema_migrations WHERE name='014-context-manifests.sql'").get() ||
    db.prepare("SELECT 1 FROM schema_migrations WHERE name>='015-'").get()
  )
    throw new Error('Preflight requires the schema after migration 014 and before 015');
  if (
    db.pragma('integrity_check', { simple: true }) !== 'ok' ||
    (db.pragma('foreign_key_check') as unknown[]).length
  )
    throw new Error('Legacy database integrity check failed');
}
export async function planLegacyConsolidation(
  db: DB,
  store: Pick<AssetStore, 'get'>,
): Promise<ConsolidationPlan> {
  legacyOnly(db);
  const before = fingerprint(db);
  const assets = db
    .prepare('SELECT id,owner_id,storage_key,mime,size FROM assets ORDER BY owner_id,id')
    .all() as Omit<LegacyAsset, 'digest' | 'canonicalId'>[];
  const checked: LegacyAsset[] = [];
  const canonical = new Map<string, LegacyAsset>();
  for (const asset of assets) {
    const bytes = await store.get(asset.storage_key, AbortSignal.timeout(30000));
    if (bytes.length !== asset.size) throw new Error(`Asset size mismatch: ${asset.id}`);
    const digest = hash(bytes),
      key = `${asset.owner_id}:${digest}`,
      first = canonical.get(key);
    if (first && first.mime !== asset.mime)
      throw new Error('Equal bytes have conflicting MIME metadata');
    const item = { ...asset, digest, canonicalId: first?.id ?? asset.id };
    checked.push(item);
    canonical.set(key, first ?? item);
  }
  const byId = new Map(checked.map((a) => [a.id, a]));
  const references = new Set<string>();
  for (const row of db
    .prepare(
      `SELECT b.owner_id,c.content_json FROM (
    SELECT block_id,content_json FROM block_live_state UNION ALL SELECT block_id,content_json FROM block_revisions
  ) c JOIN blocks b ON b.id=c.block_id`,
    )
    .iterate() as Iterable<{ owner_id: string; content_json: string }>) {
    const c = JSON.parse(row.content_json);
    if (!c.assetId) continue;
    const a = byId.get(c.assetId);
    if (!a || a.owner_id !== row.owner_id || c.assetHash !== a.digest || c.mimeType !== a.mime)
      throw new Error('Legacy content integrity or ownership mismatch');
    references.add(a.id);
  }
  if (checked.some((a) => !references.has(a.id)))
    throw new Error('Unreferenced legacy assets require separate recovery before migration');
  for (const op of db.prepare('SELECT * FROM artifact_imports').iterate() as Iterable<any>) {
    const a = byId.get(op.asset_id);
    if (a && a.owner_id !== op.owner_id) throw new Error('Legacy import ownership mismatch');
    if (op.state === 'ready') {
      const content = JSON.parse(op.result_json).content;
      if (
        !a ||
        content.assetId !== a.id ||
        content.assetHash !== a.digest ||
        content.mimeType !== a.mime
      )
        throw new Error('Legacy receipt integrity mismatch');
    }
  }
  if (db.prepare('SELECT 1 FROM upload_intents u JOIN assets a ON a.id=u.id LIMIT 1').get())
    throw new Error('Upload reservation overlaps a committed asset');
  if (before !== fingerprint(db)) throw new Error('Database changed during offline preflight');
  const redundant = checked.filter((a) => a.id !== a.canonicalId);
  return {
    version: 1,
    fingerprint: before,
    assets: checked,
    redundantObjects: redundant.length,
    redundantBytes: redundant.reduce((n, a) => n + a.size, 0),
  };
}
interface BackupManifest {
  version: 1;
  databaseHash: string;
  plan: ConsolidationPlan;
}
async function createLegacyBackup(
  db: DB,
  store: Pick<AssetStore, 'get'>,
  directory: string,
  plan: ConsolidationPlan,
) {
  await mkdir(directory, { mode: 0o700 });
  await mkdir(join(directory, 'assets'), { mode: 0o700 });
  await db.backup(join(directory, 'db.sqlite'));
  for (const asset of plan.assets) {
    if (!/^[a-f0-9-]{36}$/.test(asset.storage_key)) throw new Error('Invalid legacy storage key');
    const bytes = await store.get(asset.storage_key, AbortSignal.timeout(30000));
    if (hash(bytes) !== asset.digest) throw new Error('Asset changed while backing up');
    await writeFile(join(directory, 'assets', asset.storage_key), bytes, {
      flag: 'wx',
      mode: 0o600,
    });
  }
  const manifest: BackupManifest = {
    version: 1,
    databaseHash: await fileHash(join(directory, 'db.sqlite')),
    plan,
  };
  await writeFile(
    join(directory, 'legacy-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  await verifyLegacyBackup(directory);
}
export async function verifyLegacyBackup(directory: string): Promise<ConsolidationPlan> {
  const manifest = JSON.parse(
    await readFile(join(directory, 'legacy-manifest.json'), 'utf8'),
  ) as BackupManifest;
  if (
    manifest.version !== 1 ||
    (await fileHash(join(directory, 'db.sqlite'))) !== manifest.databaseHash
  )
    throw new Error('Legacy backup checksum mismatch');
  const db = new Database(join(directory, 'db.sqlite'), { readonly: true, fileMustExist: true });
  try {
    const plan = await planLegacyConsolidation(db, new FileAssetStore(join(directory, 'assets')));
    if (canonicalJson(plan) !== canonicalJson(manifest.plan))
      throw new Error('Legacy backup plan mismatch');
    return plan;
  } finally {
    db.close();
  }
}
const journalSchema = `CREATE TABLE IF NOT EXISTS asset_consolidation_journal (
 old_id TEXT PRIMARY KEY, canonical_id TEXT NOT NULL REFERENCES assets(id), storage_key TEXT NOT NULL UNIQUE,
 digest TEXT NOT NULL,size INTEGER NOT NULL,backup_fingerprint TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','deleting','deleted'))
);
CREATE TRIGGER IF NOT EXISTS immutable_consolidation_record BEFORE UPDATE OF old_id,canonical_id,storage_key,digest,size,backup_fingerprint ON asset_consolidation_journal
BEGIN SELECT RAISE(ABORT,'immutable consolidation record'); END;
CREATE TRIGGER IF NOT EXISTS consolidation_state_transition BEFORE UPDATE OF state ON asset_consolidation_journal
WHEN NOT ((OLD.state='pending' AND NEW.state='deleting') OR (OLD.state='deleting' AND NEW.state IN ('deleting','deleted')))
BEGIN SELECT RAISE(ABORT,'invalid consolidation transition'); END;
`;
export async function consolidateLegacyAssets(
  db: DB,
  store: Pick<AssetStore, 'get'>,
  backupDirectory: string,
  onStage?: (stage: 'beforeCommit' | 'afterCommit') => void,
) {
  const plan = await planLegacyConsolidation(db, store);
  let existingBackup = false;
  try {
    await lstat(backupDirectory);
    existingBackup = true;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (existingBackup) {
    if (canonicalJson(await verifyLegacyBackup(backupDirectory)) !== canonicalJson(plan))
      throw new Error('Existing backup belongs to another preflight');
  } else await createLegacyBackup(db, store, backupDirectory, plan);
  db.transaction(() => {
    if (fingerprint(db) !== plan.fingerprint)
      throw new Error('Database changed since verified backup');
    db.exec(journalSchema);
    const trigger = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='immutable_revision_update'",
      )
      .get() as { sql: string };
    db.exec('DROP TRIGGER immutable_revision_update');
    for (const asset of plan.assets.filter((a) => a.id !== a.canonicalId)) {
      for (const table of ['block_live_state', 'block_revisions']) {
        db.prepare(
          `UPDATE ${table} SET content_json=json_set(content_json,'$.assetId',?) WHERE json_extract(content_json,'$.assetId')=?`,
        ).run(asset.canonicalId, asset.id);
      }
      db.prepare(
        `UPDATE artifact_imports SET asset_id=?,result_json=CASE WHEN result_json IS NULL THEN NULL ELSE json_set(result_json,'$.content.assetId',?) END WHERE asset_id=?`,
      ).run(asset.canonicalId, asset.canonicalId, asset.id);
      db.prepare("INSERT INTO asset_consolidation_journal VALUES (?,?,?,?,?,?,'pending')").run(
        asset.id,
        asset.canonicalId,
        asset.storage_key,
        asset.digest,
        asset.size,
        plan.fingerprint,
      );
      db.prepare('DELETE FROM assets WHERE id=?').run(asset.id);
    }
    db.exec(trigger.sql);
    if ((db.pragma('foreign_key_check') as unknown[]).length)
      throw new Error('Consolidation violates foreign keys');
    onStage?.('beforeCommit');
  }).exclusive();
  onStage?.('afterCommit');
  return plan;
}
// Require a migrated DB and its verified pre-consolidation backup. No runtime server may write.
export async function cleanupConsolidatedAssets(
  db: DB,
  store: AssetStore,
  backupDirectory: string,
  onStage?: (stage: 'afterDelete') => void,
) {
  const backup = await verifyLegacyBackup(backupDirectory);
  await verifyRestoration(db, store);
  const rows = db
    .prepare("SELECT * FROM asset_consolidation_journal WHERE state!='deleted' ORDER BY old_id")
    .all() as {
    old_id: string;
    canonical_id: string;
    storage_key: string;
    digest: string;
    size: number;
    backup_fingerprint: string;
    state: string;
  }[];
  for (const row of rows) {
    const original = backup.assets.find((a) => a.id === row.old_id);
    if (
      row.backup_fingerprint !== backup.fingerprint ||
      !original ||
      original.canonicalId !== row.canonical_id ||
      original.storage_key !== row.storage_key ||
      original.digest !== row.digest ||
      original.size !== row.size
    )
      throw new Error('Cleanup journal does not match verified backup');
    if (
      db.prepare('SELECT 1 FROM assets WHERE storage_key=?').get(row.storage_key) ||
      db.prepare('SELECT 1 FROM upload_intents WHERE id=?').get(row.storage_key)
    )
      throw new Error('Redundant object is still referenced');
    const canonical = db
      .prepare('SELECT storage_key,digest FROM assets WHERE id=?')
      .get(row.canonical_id) as { storage_key: string; digest: string } | undefined;
    if (
      !canonical ||
      canonical.digest !== row.digest ||
      hash(await store.get(canonical.storage_key, AbortSignal.timeout(30000))) !== row.digest
    )
      throw new Error('Canonical object failed cleanup integrity verification');
    let present = true;
    try {
      if (hash(await store.get(row.storage_key, AbortSignal.timeout(30000))) !== row.digest)
        throw new Error('Redundant object changed');
    } catch (error) {
      if (isMissing(error))
        present = false; // A restored canonical-only bundle may omit redundant objects.
      else throw error;
    }
    db.prepare("UPDATE asset_consolidation_journal SET state='deleting' WHERE old_id=?").run(
      row.old_id,
    );
    if (present) await store.delete(row.storage_key);
    onStage?.('afterDelete');
    db.prepare("UPDATE asset_consolidation_journal SET state='deleted' WHERE old_id=?").run(
      row.old_id,
    );
  }
  return { deleted: rows.length };
}
function isMissing(error: unknown) {
  const e = error as { code?: string; name?: string };
  return ['ENOENT', 'NoSuchKey', 'NotFound'].includes(e.code ?? e.name ?? '');
}
