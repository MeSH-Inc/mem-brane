import { createHash } from 'node:crypto';
import type { DB } from '../db/index.js';
import type { AssetStore } from '../storage/assets.js';
import type { Content } from '../../shared/types/domain.js';
import { importIntent } from '../../shared/schemas/index.js';
import { canEditBrane, DomainError } from '../domain/access.js';
import { config } from '../app/config.js';
import { reserveUpload } from './capacity.js';
import { createBlock, now, uid } from './content.js';
import { inspectPdf } from '../ingestion/pdf.js';
import { inspectImage } from '../ingestion/image.js';

interface Operation {
  request_hash: string;
  asset_id: string;
  brane_id: string;
  state: 'pending' | 'ready';
  result_json: string | null;
}
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export function createImports(db: DB, store: AssetStore) {
  const active = new Map<string, { hash: string; promise: Promise<unknown> }>();
  const read = (actor: string, key: string) =>
    db.prepare('SELECT * FROM artifact_imports WHERE owner_id=? AND key=?').get(actor, key) as
      Operation | undefined;
  return {
    status(actor: string, key: string) {
      const op = read(actor, key);
      if (!op) throw new DomainError(404, 'Import not found');
      canEditBrane(db, actor, op.brane_id);
      return op.state === 'ready'
        ? { state: 'ready', result: JSON.parse(op.result_json!) }
        : { state: 'pending' };
    },
    async import(actor: string, rawIntent: unknown, file: File) {
      const intent = importIntent.parse(rawIntent);
      canEditBrane(db, actor, intent.braneId);
      if (!(file instanceof File) || !file.size || file.size > config.MAX_UPLOAD_BYTES)
        throw new DomainError(400, `Choose a nonempty file up to ${config.MAX_UPLOAD_BYTES} bytes`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const assetHash = hash(bytes);
      const filename = file.name.slice(0, 200) || 'Pasted image';
      const requestHash = hash(JSON.stringify({ intent, filename, assetHash }));
      const identity = `${actor}:${intent.key}`;
      const existing = read(actor, intent.key);
      if (existing && existing.request_hash !== requestHash)
        throw new DomainError(409, 'This import key belongs to different content or placement');
      if (existing?.state === 'ready') return JSON.parse(existing.result_json!);
      const running = active.get(identity);
      if (running) {
        if (running.hash !== requestHash) throw new DomainError(409, 'Import key conflict');
        return running.promise;
      }
      if (active.size >= 4) throw new DomainError(429, 'Import capacity reached; retry shortly');
      const work = async () => {
        let assetId = existing?.asset_id ?? uid();
        const base = { text: filename, filename, assetId, assetHash };
        const content: Content =
          Buffer.from(bytes.subarray(0, 5)).toString('ascii') === '%PDF-'
            ? { ...base, format: 'pdf', mimeType: 'application/pdf', ...(await inspectPdf(bytes)) }
            : {
                ...base,
                format: 'image',
                ...(await inspectImage(bytes)),
                representation: 'original-image-v1',
              };
        db.transaction(() => {
          const known = db
            .prepare('SELECT id FROM assets WHERE owner_id=? AND digest=?')
            .get(actor, assetHash) as { id: string } | undefined;
          const pending = db
            .prepare('SELECT id FROM upload_intents WHERE owner_id=? AND digest=?')
            .get(actor, assetHash) as { id: string } | undefined;
          assetId = known?.id ?? pending?.id ?? assetId;
          content.assetId = assetId;
          if (!known && !db.prepare('SELECT 1 FROM upload_intents WHERE id=?').get(assetId))
            reserveUpload(db, actor, assetId, bytes.length, {
              userBytes: config.USER_STORAGE_BYTES,
              totalBytes: config.TOTAL_STORAGE_BYTES,
            });
          if (!known)
            db.prepare('UPDATE upload_intents SET digest=? WHERE id=?').run(assetHash, assetId);
          if (!existing)
            db.prepare("INSERT INTO artifact_imports VALUES (?,?,?,?,?,'pending',NULL,?)").run(
              actor,
              intent.key,
              requestHash,
              assetId,
              intent.braneId,
              now(),
            );
          else
            db.prepare('UPDATE artifact_imports SET asset_id=? WHERE owner_id=? AND key=?').run(
              assetId,
              actor,
              intent.key,
            );
        }).immediate();
        // A previous process may have stored the immutable object but lost the acknowledgement.
        let stored: Uint8Array | undefined;
        {
          try {
            stored = await store.get(assetId, AbortSignal.timeout(30000));
          } catch (error) {
            const code = (error as { code?: string; name?: string }).code ?? (error as Error).name;
            if (!['ENOENT', 'NoSuchKey', 'NotFound'].includes(code)) throw error;
          }
        }
        if (stored) {
          if (hash(stored) !== assetHash)
            throw new DomainError(409, 'Import bytes failed integrity verification');
        } else {
          try {
            await store.put(assetId, bytes, content.mimeType!);
          } catch (error) {
            // Only an immutable-object collision is an acknowledgement; transport errors
            // retain the reservation so an explicit retry verifies the uncertain write.
            const e = error as {
              code?: string;
              name?: string;
              $metadata?: { httpStatusCode?: number };
            };
            if (
              e.code !== 'EEXIST' &&
              e.name !== 'PreconditionFailed' &&
              e.$metadata?.httpStatusCode !== 412
            )
              throw error;
            if (hash(await store.get(assetId, AbortSignal.timeout(30000))) !== assetHash)
              throw new DomainError(409, 'Import bytes failed integrity verification');
          }
        }
        return db.transaction(() => {
          canEditBrane(db, actor, intent.braneId);
          const finished = read(actor, intent.key);
          if (finished?.state === 'ready') return JSON.parse(finished.result_json!);
          db.prepare(
            'INSERT INTO assets (id,owner_id,storage_key,mime,size,created_at,digest) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
          ).run(assetId, actor, assetId, content.mimeType, bytes.length, now(), assetHash);
          const result = createBlock(
            db,
            actor,
            content.format,
            content,
            intent.braneId,
            intent.geometry,
          );
          db.prepare('DELETE FROM upload_intents WHERE id=?').run(assetId);
          db.prepare(
            "UPDATE artifact_imports SET state='ready',result_json=? WHERE owner_id=? AND key=?",
          ).run(JSON.stringify(result), actor, intent.key);
          return result;
        })();
      };
      const promise = work();
      active.set(identity, { hash: requestHash, promise });
      try {
        return await promise;
      } finally {
        active.delete(identity);
      }
    },
  };
}
