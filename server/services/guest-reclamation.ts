import type { DB } from '../db/index.js';
import type { AssetStore } from '../storage/assets.js';
import { guestRecoveryGrace } from './guest-claims.js';
import { activeImportLibraries } from './imports.js';

function validateBatch(batchSize: number) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    throw new Error('Invalid guest reclamation batch size');
}

// The server has one database connection and import registry. No await may occur
// between checking that registry and committing the purge: active writes finish
// first, and imports still reading a request body must reauthorize before reserving.
export function reclaimExpiredGuests(db: DB, batchSize: number, time = Date.now()) {
  validateBatch(batchSize);
  return db
    .transaction(() => {
      const guests = db
        .prepare(
          `
      SELECT g.library_id,l.principal_id FROM guest_libraries g
      JOIN libraries l ON l.id=g.library_id
      WHERE g.claimed_by IS NULL AND g.purged_at IS NULL AND g.expires_at<=?
      AND g.library_id NOT IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM library_claims c WHERE c.library_id=g.library_id)
      -- Guest capabilities exclude paid work. Preserve unexpected historical work
      -- and billing evidence instead of erasing it through guest retention.
      AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.owner_id=g.library_id)
      AND NOT EXISTS (SELECT 1 FROM spend_commitments s WHERE s.owner_id=g.library_id)
      AND NOT EXISTS (SELECT 1 FROM context_manifests c WHERE c.owner_id=g.library_id)
      AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.owner_id=g.library_id)
      AND NOT EXISTS (SELECT 1 FROM ingestions i JOIN blocks b ON b.id=i.block_id
        WHERE b.owner_id=g.library_id AND i.status IN ('queued','running'))
      ORDER BY g.expires_at,g.library_id LIMIT ?
    `,
        )
        .all(time - guestRecoveryGrace, JSON.stringify(activeImportLibraries(db)), batchSize) as {
        library_id: string;
        principal_id: string;
      }[];
      let reclaimed = 0;
      for (const guest of guests) {
        const library = guest.library_id;
        db.prepare('UPDATE guest_libraries SET purged_at=? WHERE library_id=?').run(time, library);
        // Moving each byte charge to the outbox and deleting its SQL owner happen
        // together. Failed or uncertain remote deletion never frees capacity.
        db.prepare(
          `
        INSERT INTO guest_object_deletions(storage_key,library_id,size)
        SELECT storage_key,?,MAX(size) FROM (
          SELECT storage_key,size FROM assets WHERE owner_id=?
          UNION ALL SELECT id,size FROM upload_intents WHERE owner_id=?
        ) GROUP BY storage_key
      `,
        ).run(library, library, library);
        const ownedBlocks = 'SELECT id FROM blocks WHERE owner_id=?';
        const ownedAssets = 'SELECT id FROM assets WHERE owner_id=?';
        db.prepare('DELETE FROM artifact_imports WHERE owner_id=?').run(library);
        db.prepare('DELETE FROM workspace_operations WHERE owner_id=?').run(library);
        db.prepare('DELETE FROM workshop_machines WHERE owner_id=?').run(library);
        for (const table of ['placements', 'ingestions', 'block_live_state', 'block_revisions'])
          db.prepare(`DELETE FROM ${table} WHERE block_id IN (${ownedBlocks})`).run(library);
        db.prepare('DELETE FROM blocks WHERE owner_id=?').run(library);
        db.prepare('DELETE FROM branes WHERE owner_id=?').run(library);
        db.prepare(`DELETE FROM extraction_results WHERE asset_id IN (${ownedAssets})`).run(
          library,
        );
        db.prepare(
          `DELETE FROM representation_summaries WHERE representation_id IN (
        SELECT id FROM asset_representations WHERE asset_id IN (${ownedAssets})
      )`,
        ).run(library);
        db.prepare(`DELETE FROM asset_representations WHERE asset_id IN (${ownedAssets})`).run(
          library,
        );
        db.prepare('DELETE FROM assets WHERE owner_id=?').run(library);
        db.prepare('DELETE FROM upload_intents WHERE owner_id=?').run(library);
        db.prepare('DELETE FROM guest_claim_intents WHERE library_id=?').run(library);
        db.prepare('DELETE FROM session WHERE userId=?').run(guest.principal_id);
        reclaimed++;
      }
      return reclaimed;
    })
    .immediate();
}

export async function deleteGuestObjects(
  db: DB,
  store: AssetStore,
  batchSize: number,
  time = Date.now(),
  signal?: AbortSignal,
) {
  validateBatch(batchSize);
  const deadline = AbortSignal.timeout(30000);
  const deletionSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const objects = db
    .prepare(
      `
    SELECT d.storage_key,d.attempts FROM guest_object_deletions d
    JOIN guest_libraries g ON g.library_id=d.library_id
    WHERE d.next_attempt_at<=? AND g.purged_at IS NOT NULL
    ORDER BY d.next_attempt_at,d.storage_key LIMIT ?
  `,
    )
    .all(time, batchSize) as { storage_key: string; attempts: number }[];
  let deleted = 0,
    failed = 0;
  for (const object of objects) {
    if (deletionSignal.aborted) break;
    try {
      await store.delete(object.storage_key, deletionSignal);
    } catch (error) {
      const details = error as { code?: string; name?: string } | null;
      const code = details?.code ?? details?.name;
      // A lost acknowledgement or a reserved object that was never written is
      // safely retried; only an explicit missing-object response is success.
      if (!code || !['ENOENT', 'NoSuchKey', 'NotFound'].includes(code)) {
        db.prepare(
          `UPDATE guest_object_deletions SET attempts=attempts+1,next_attempt_at=?
          WHERE storage_key=?`,
        ).run(
          time + Math.min(3600000, 60000 * 2 ** Math.min(object.attempts, 6)),
          object.storage_key,
        );
        failed++;
        continue;
      }
    }
    db.prepare('DELETE FROM guest_object_deletions WHERE storage_key=?').run(object.storage_key);
    deleted++;
  }
  return { deleted, failed };
}
