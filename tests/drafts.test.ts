import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import {
  DraftRecovery,
  indexedDraftStorage,
  draftKey,
  draftDisposition,
  type Draft,
} from '../src/services/drafts';
const record = (text = 'Offline draft'): Draft => ({
  key: 'test-draft',
  actor: 'alice',
  blockId: 'block',
  text,
  baseVersion: 3,
  baseText: 'Original',
  updatedAt: Date.now(),
});
it('recovers offline text and its original version after a new storage instance', async () => {
  const first = new DraftRecovery(indexedDraftStorage());
  const saved = record();
  await first.save(saved);
  const second = new DraftRecovery(indexedDraftStorage());
  expect((await second.load('alice'))[0]).toEqual(saved);
  expect(await second.load('bob')).toEqual([]);
});
it('serializes rapid saves and clearing so a stale write cannot resurrect a saved draft', async () => {
  const recovery = new DraftRecovery(indexedDraftStorage());
  const a = recovery.save(record('a')),
    b = recovery.save(record('b')),
    c = recovery.remove(record().key);
  await Promise.all([a, b, c]);
  expect(await recovery.load('alice')).toEqual([]);
});
it('never treats a remotely changed version as permission to overwrite', () => {
  expect(draftDisposition(record(), { version: 4, content: { text: 'Remote' } })).toBe('conflict');
  expect(draftDisposition(record(), { version: 3, content: { text: 'Old' } })).toBe('recoverable');
  expect(draftDisposition(record(), { version: 4, content: { text: 'Offline draft' } })).toBe(
    'saved',
  );
});

it('keeps independent drafts when another editing session saves and clears its copy', async () => {
  const storage = indexedDraftStorage();
  const a = { ...record('Tab A'), key: draftKey() };
  const b = { ...record('Tab B'), key: draftKey() };
  await Promise.all([storage.put(a), storage.put(b)]);
  await storage.remove(a.key);
  expect(await storage.list('alice')).toContainEqual(b);
  await storage.remove(b.key);
});

it('removes only the exact retained copy and treats an already removed copy as complete', async () => {
  const storage = indexedDraftStorage();
  const original = { ...record(), key: draftKey() };
  const copy = { ...original, key: draftKey() };
  await storage.put(original);
  await storage.put(copy);
  expect(await storage.removeIfUnchanged(original)).toBe('removed');
  expect(await storage.removeIfUnchanged(original)).toBe('missing');
  expect(await storage.list('alice')).toContainEqual(copy);
  await storage.remove(copy.key);
});

it.each([
  { text: 'A newer edit' },
  { baseText: 'A different base' },
  { baseVersion: 4 },
  { actor: 'bob' },
  { blockId: 'another-block' },
  { updatedAt: 999 },
])('keeps a copy changed by another connection: %j', async (change) => {
  const reader = indexedDraftStorage(),
    writer = indexedDraftStorage();
  const shown = { ...record(), key: draftKey(), updatedAt: 123 };
  const newer = { ...shown, ...change };
  await writer.put(shown);
  await writer.put(newer);
  expect(await reader.removeIfUnchanged(shown)).toBe('changed');
  expect(await writer.list(newer.actor)).toContainEqual(newer);
  await writer.remove(newer.key);
});

it('serializes discard after pending local writes without deleting their newer value', async () => {
  const recovery = new DraftRecovery(indexedDraftStorage());
  const shown = { ...record(), key: draftKey() };
  const newer = { ...shown, text: 'Changed in the same millisecond' };
  const first = recovery.save(shown);
  const second = recovery.save(newer);
  const removal = recovery.discard(shown);
  await Promise.all([first, second]);
  expect(await removal).toBe('changed');
  expect(await recovery.load('alice')).toContainEqual(newer);
  await recovery.remove(newer.key);
});

it('never deletes a concurrently written newer value regardless of transaction order', async () => {
  const reader = indexedDraftStorage(),
    writer = indexedDraftStorage();
  const shown = { ...record(), key: draftKey() };
  const newer = { ...shown, text: 'Concurrent text' };
  await writer.put(shown);
  await Promise.all([reader.removeIfUnchanged(shown), writer.put(newer)]);
  expect(await reader.list('alice')).toContainEqual(newer);
  await writer.remove(newer.key);
});

it('reports a failed discard without poisoning recovery or removing the saved copy', async () => {
  const storage = indexedDraftStorage();
  let fail = true;
  const recovery = new DraftRecovery({
    ...storage,
    removeIfUnchanged: async (expected) => {
      if (fail) throw new Error('Storage unavailable');
      return storage.removeIfUnchanged(expected);
    },
  });
  const shown = { ...record(), key: draftKey() };
  await recovery.save(shown);
  await expect(recovery.discard(shown)).rejects.toThrow('Storage unavailable');
  expect(await recovery.load('alice')).toContainEqual(shown);
  fail = false;
  expect(await recovery.discard(shown)).toBe('removed');
});
