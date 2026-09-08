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
  key: draftKey('alice', 'block'),
  actor: 'alice',
  blockId: 'block',
  text,
  baseVersion: 3,
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
