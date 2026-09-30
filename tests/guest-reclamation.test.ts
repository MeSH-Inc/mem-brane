import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { openDatabase, type DB } from '../server/db/index';
import { config } from '../server/app/config';
import { Maintenance } from '../server/app/maintenance';
import { authorizeLibrary } from '../server/domain/libraries';
import { createBrane, createTextBlock, revisions, uid } from '../server/services/content';
import { reserveUpload } from '../server/services/capacity';
import { claimGuestLibrary, guestRecoveryGrace } from '../server/services/guest-claims';
import { reclaimExpiredGuests, deleteGuestObjects } from '../server/services/guest-reclamation';
import { createImports } from '../server/services/imports';
import { submitRun } from '../server/services/runs';
import type { AssetStore } from '../server/storage/assets';

let db: DB, directory: string, path: string;
const objects = new Map<string, Uint8Array>();
const store: AssetStore = {
  async put(key, bytes) {
    objects.set(key, bytes);
  },
  async get(key) {
    const bytes = objects.get(key);
    if (!bytes) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return bytes;
  },
  async delete(key) {
    if (!objects.delete(key)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  },
  async createReadUrl() {
    return '';
  },
};
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mem-brane-guest-reclamation-'));
  path = join(directory, 'state.db');
  db = openDatabase(path);
  objects.clear();
});
afterEach(() => {
  vi.useRealTimers();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
function owner(anonymous = true) {
  const id = uid();
  db.prepare(
    'INSERT INTO user(id,name,email,createdAt,updatedAt,isAnonymous) VALUES (?,?,?,?,?,?)',
  ).run(id, 'Test', `${id}@example.com`, Date.now(), Date.now(), Number(anonymous));
  return id;
}
function expired(actor: string, time = Date.now()) {
  db.prepare('UPDATE guest_libraries SET expires_at=? WHERE library_id=?').run(
    time - guestRecoveryGrace,
    actor,
  );
}
function count(table: string) {
  return (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function image() {
  const bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
  return new File([new Uint8Array(bytes)], 'Guest.png', { type: 'image/png' });
}
const intent = (braneId: string) => ({
  key: uid(),
  braneId,
  target: 'composer',
  geometry: { x: 0, y: 0, width: 320, height: 300 },
});

it('retains active guests and the entire seven-day claim grace, then releases admission in bounded batches', () => {
  const a = owner(),
    b = owner(),
    c = owner();
  for (const id of [a, b, c]) createBrane(db, id);
  const time = Date.now();
  expired(a, time);
  expired(b, time);
  db.prepare('UPDATE guest_policy SET library_limit=3').run();
  expect(() => owner()).toThrow('capacity');
  expect(reclaimExpiredGuests(db, 1, time - 1)).toBe(0);
  expect(reclaimExpiredGuests(db, 1, time)).toBe(1);
  expect(count('branes')).toBe(2);
  expect(() => owner()).not.toThrow();
  expect(reclaimExpiredGuests(db, 1, time)).toBe(1);
  expect(reclaimExpiredGuests(db, 1, time)).toBe(0);
  expect(db.prepare('SELECT purged_at FROM guest_libraries WHERE library_id=?').get(c)).toEqual({
    purged_at: null,
  });
});

it('serializes claim and purge decisions across connections without deleting a claimed graph', () => {
  const keeper = owner(false),
    a = owner(),
    b = owner();
  const block = createTextBlock(db, a, createBrane(db, a).id);
  const time = Date.now();
  expired(a, time + 60000);
  expired(b, time);
  const claimant = openDatabase(path);
  try {
    expect(claimGuestLibrary(claimant, a, keeper, a)).toBe(a);
    expect(reclaimExpiredGuests(db, 10, time + 60000)).toBe(1);
    expect(db.prepare('SELECT id FROM blocks WHERE id=?').get(block.id)).toEqual({ id: block.id });
    expect(claimGuestLibrary(claimant, a, keeper, a)).toBe(a);
    expect(() => claimGuestLibrary(claimant, b, keeper, b)).toThrow('expired');
    expect(() =>
      db.prepare('UPDATE guest_libraries SET claimed_by=? WHERE library_id=?').run(keeper, b),
    ).toThrow('cannot be changed');
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    claimant.close();
  }
});

it('reclaims revisions, representations, imports and receipts while preserving live-library immutability', async () => {
  const guest = owner(),
    member = owner(false);
  const brane = createBrane(db, guest).id;
  const receipt = await createImports(db, store).import(guest, intent(brane), await image());
  revisions(db).snapshotBlock(guest, receipt.blockId);
  db.prepare('INSERT INTO workspace_operations VALUES (?,?,?,?)').run(
    guest,
    uid(),
    'hash',
    Date.now(),
  );
  const memberBlock = createTextBlock(db, member, createBrane(db, member).id);
  const memberRevision = revisions(db).snapshotBlock(member, memberBlock.id);
  expect(() => db.prepare('DELETE FROM block_revisions WHERE id=?').run(memberRevision.id)).toThrow(
    'immutable',
  );
  expect(() => db.prepare('DELETE FROM asset_representations').run()).toThrow('immutable');
  expired(guest);
  expect(reclaimExpiredGuests(db, 10)).toBe(1);
  expect(count('blocks')).toBe(1);
  expect(count('block_revisions')).toBe(1);
  for (const table of [
    'asset_representations',
    'representation_summaries',
    'assets',
    'artifact_imports',
    'extraction_results',
    'workspace_operations',
  ])
    expect(count(table), table).toBe(0);
  expect(count('guest_object_deletions')).toBe(1);
  expect(objects.size).toBe(1);
  expect(await deleteGuestObjects(db, store, 10)).toEqual({ deleted: 1, failed: 0 });
  expect(objects.size).toBe(0);
  expect(db.pragma('foreign_key_check')).toEqual([]);
});

it('keeps uncertain deletion bytes charged through restart, retries with backoff, and acknowledges missing objects', async () => {
  const a = owner(),
    b = owner(),
    key = uid();
  reserveUpload(db, a, key, 60, { userBytes: 1000, totalBytes: 1000 });
  objects.set(key, new Uint8Array(60));
  const time = Date.now();
  expired(a, time);
  expect(reclaimExpiredGuests(db, 10, time)).toBe(1);
  const oldLimit = config.GUEST_TOTAL_STORAGE_BYTES;
  config.GUEST_TOTAL_STORAGE_BYTES = 100;
  try {
    const uncertain = {
      ...store,
      async delete(key: string) {
        await store.delete(key);
        throw new Error('Lost acknowledgement');
      },
    };
    expect(await deleteGuestObjects(db, uncertain, 10, time)).toEqual({ deleted: 0, failed: 1 });
    expect(() => reserveUpload(db, b, uid(), 60, { userBytes: 1000, totalBytes: 1000 })).toThrow(
      'Guest upload capacity',
    );
    db.close();
    db = openDatabase(path);
    expect(await deleteGuestObjects(db, store, 10, time + 59999)).toEqual({
      deleted: 0,
      failed: 0,
    });
    expect(await deleteGuestObjects(db, store, 10, time + 60000)).toEqual({
      deleted: 1,
      failed: 0,
    });
    expect(count('guest_object_deletions')).toBe(0);
    expect(() =>
      reserveUpload(db, b, uid(), 60, { userBytes: 1000, totalBytes: 1000 }),
    ).not.toThrow();
  } finally {
    config.GUEST_TOTAL_STORAGE_BYTES = oldLimit;
  }
});

it('rolls back the purge and deletion debt together if graph cleanup fails', () => {
  const actor = owner();
  createTextBlock(db, actor, createBrane(db, actor).id);
  reserveUpload(db, actor, uid(), 10, { userBytes: 1000, totalBytes: 1000 });
  expired(actor);
  db.exec(
    "CREATE TRIGGER fail_guest_delete BEFORE DELETE ON blocks BEGIN SELECT RAISE(ABORT,'fixture'); END",
  );
  expect(() => reclaimExpiredGuests(db, 10)).toThrow('fixture');
  expect(count('upload_intents')).toBe(1);
  expect(count('guest_object_deletions')).toBe(0);
  expect(db.prepare('SELECT purged_at FROM guest_libraries').get()).toEqual({ purged_at: null });
  db.exec('DROP TRIGGER fail_guest_delete');
  expect(reclaimExpiredGuests(db, 10)).toBe(1);
});

it('bounds deletion batches and lets later objects progress while a failed deletion backs off', async () => {
  const actor = owner();
  for (let i = 0; i < 2; i++)
    reserveUpload(db, actor, uid(), 10, { userBytes: 1000, totalBytes: 1000 });
  expired(actor);
  reclaimExpiredGuests(db, 10);
  const remove = vi.fn(async () => {
    throw new Error('Storage unavailable');
  });
  const time = Date.now();
  expect(await deleteGuestObjects(db, { ...store, delete: remove }, 1, time)).toEqual({
    deleted: 0,
    failed: 1,
  });
  // Both objects are absent: missing acknowledges only the other, due object.
  expect(await deleteGuestObjects(db, store, 1, time)).toEqual({ deleted: 1, failed: 0 });
  expect(count('guest_object_deletions')).toBe(1);
  expect(remove).toHaveBeenCalledTimes(1);
});

it('cancels storage deletion on shutdown without clearing debt or starting another object', async () => {
  const actor = owner();
  for (let i = 0; i < 2; i++)
    reserveUpload(db, actor, uid(), 10, { userBytes: 1000, totalBytes: 1000 });
  expired(actor);
  reclaimExpiredGuests(db, 10);
  const abort = new AbortController();
  const remove = vi.fn(async (_key: string, signal?: AbortSignal) => {
    expect(signal).toBeDefined();
    await new Promise<void>((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    });
  });
  const deleting = deleteGuestObjects(
    db,
    { ...store, delete: remove },
    10,
    Date.now(),
    abort.signal,
  );
  abort.abort();
  expect(await deleting).toEqual({ deleted: 0, failed: 1 });
  expect(count('guest_object_deletions')).toBe(2);
  expect(remove).toHaveBeenCalledTimes(1);
});

it('retains active work and all billing evidence even if an unexpected guest has paid history', () => {
  const actor = owner(),
    webpageOwner = owner();
  const run = submitRun(
    db,
    revisions(db),
    actor,
    {
      braneId: createBrane(db, actor).id,
      key: uid(),
      model: 'mock',
      prompt: 'Test',
      references: [],
      edits: [],
    },
    { models: ['mock'], maxTokens: 100, userConcurrency: 10, maxContextCharacters: 100000 },
  );
  const block = createTextBlock(db, webpageOwner, createBrane(db, webpageOwner).id);
  db.prepare('INSERT INTO ingestions VALUES (?,?,?,?)').run(block.id, 'running', null, Date.now());
  expired(actor);
  expired(webpageOwner);
  expect(reclaimExpiredGuests(db, 10)).toBe(0);
  db.prepare("UPDATE runs SET status='interrupted' WHERE id=?").run(run.id);
  db.prepare("UPDATE spend_commitments SET status='uncertain' WHERE run_id=?").run(run.id);
  expect(reclaimExpiredGuests(db, 10)).toBe(0);
  db.prepare(
    "UPDATE spend_commitments SET status='confirmed',confirmed_microusd=10 WHERE run_id=?",
  ).run(run.id);
  expect(reclaimExpiredGuests(db, 10)).toBe(0);
  db.prepare("UPDATE ingestions SET status='failed'").run();
  expect(reclaimExpiredGuests(db, 10)).toBe(1);
  expect(count('runs')).toBe(1);
  expect(count('spend_commitments')).toBe(1);
});

it('waits for a live upload before reclamation, then deletes its uncertain object without allowing publication', async () => {
  const actor = owner(),
    brane = createBrane(db, actor).id;
  const entered = deferred(),
    release = deferred();
  const importing = createImports(db, {
    ...store,
    async put(key, bytes, mime) {
      entered.resolve();
      await release.promise;
      await store.put(key, bytes, mime);
    },
  }).import(actor, intent(brane), await image(), () => {
    authorizeLibrary(db, actor, actor);
  });
  const failed = expect(importing).rejects.toThrow('expired');
  await entered.promise;
  const time = Date.now();
  expired(actor, time - 1);
  const waiting = owner();
  expired(waiting, time);
  // A blocked oldest guest must not starve the next guest even at batch size one.
  expect(reclaimExpiredGuests(db, 1, time)).toBe(1);
  expect(db.prepare('SELECT purged_at FROM guest_libraries WHERE library_id=?').get(actor)).toEqual(
    { purged_at: null },
  );
  release.resolve();
  await failed;
  expect(count('assets')).toBe(0);
  expect(count('upload_intents')).toBe(1);
  expect(reclaimExpiredGuests(db, 10)).toBe(1);
  expect(await deleteGuestObjects(db, store, 10)).toEqual({ deleted: 1, failed: 0 });
  expect(objects.size).toBe(0);
});

it('cannot reserve or recreate an object when purge wins while the request body is being read', async () => {
  const actor = owner(),
    brane = createBrane(db, actor).id;
  const file = await image(),
    bytes = await file.arrayBuffer(),
    release = deferred();
  vi.spyOn(file, 'arrayBuffer').mockImplementation(async () => {
    await release.promise;
    return bytes;
  });
  const importing = createImports(db, store).import(actor, intent(brane), file);
  const failed = expect(importing).rejects.toThrow('Resource not found');
  expired(actor);
  expect(reclaimExpiredGuests(db, 10)).toBe(1);
  release.resolve();
  await failed;
  expect(count('assets')).toBe(0);
  expect(count('upload_intents')).toBe(0);
  expect(objects.size).toBe(0);
});

it('maintenance drains in-flight deletion before shutdown and never overlaps its batches', async () => {
  const actor = owner(),
    key = uid(),
    entered = deferred(),
    release = deferred();
  reserveUpload(db, actor, key, 10, { userBytes: 1000, totalBytes: 1000 });
  expired(actor);
  vi.useFakeTimers();
  const remove = vi.fn(async () => {
    entered.resolve();
    await release.promise;
  });
  const fatal = vi.fn();
  const maintenance = new Maintenance(
    db,
    { completedCheckpointDays: 7, batchSize: 10 },
    { ...store, delete: remove },
    fatal,
  );
  maintenance.start();
  await entered.promise;
  await vi.advanceTimersByTimeAsync(120000);
  expect(remove).toHaveBeenCalledTimes(1);
  let stopped = false;
  const stop = maintenance.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  release.resolve();
  await stop;
  expect(count('guest_object_deletions')).toBe(0);
  expect(fatal).not.toHaveBeenCalled();
});
