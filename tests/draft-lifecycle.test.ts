import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { useInteraction } from '../src/stores/interaction';
import { draftKey, indexedDraftStorage, type Draft } from '../src/services/drafts';

it('removing a retained source leaves the recovered and edited copy active and durable', async () => {
  const actor = crypto.randomUUID();
  const source: Draft = {
    key: draftKey(),
    actor,
    blockId: 'note',
    text: 'Retained',
    baseText: 'Base',
    baseVersion: 1,
    updatedAt: 1,
  };
  const storage = indexedDraftStorage();
  await storage.put(source);
  await useInteraction.getState().initialize(actor);
  useInteraction.getState().recoverDraft(source);
  useInteraction.getState().draft('note', 'Edited recovery', 1, 'Base');
  await useInteraction.getState().flushRecovery();
  const copy = useInteraction.getState().draftRecords.note;
  expect(copy.key).not.toBe(source.key);
  expect(await useInteraction.getState().discardDraft(source)).toBe('removed');
  expect(useInteraction.getState().drafts.note).toBe('Edited recovery');
  expect(await storage.list(actor)).toEqual([copy]);
  await storage.remove(copy.key);
});

it('refuses to discard another actor’s record or the active editor’s record', async () => {
  const actor = crypto.randomUUID();
  await useInteraction.getState().initialize(actor);
  useInteraction.getState().draft('note', 'Active edit', 1, 'Base');
  await useInteraction.getState().flushRecovery();
  const active = useInteraction.getState().draftRecords.note;
  await expect(
    useInteraction.getState().discardDraft({ ...active, actor: 'someone-else' }),
  ).rejects.toThrow('another account');
  await expect(useInteraction.getState().discardDraft(active)).rejects.toThrow('being edited here');
  const storage = indexedDraftStorage();
  expect(await storage.list(actor)).toEqual([active]);
  await storage.remove(active.key);
});
