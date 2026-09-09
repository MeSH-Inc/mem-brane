import { expect, it, vi } from 'vitest';
import { WorkspaceDrafts } from '../src/services/workspace-drafts';
const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => {
    values.set(key, value);
  },
};
let draft: WorkspaceDrafts;
const mount = (actor = 'alice', brane = 'research') => {
  draft = new WorkspaceDrafts(actor, brane, storage);
};
it('isolates accounts and workspaces and preserves ordered composer intent', () => {
  mount();
  const intent = {
    prompt: 'Compare',
    model: 'mock',
    references: ['b', 'a'],
    continueFrom: 'branch',
    title: 'Unfinished',
  };
  draft.update(intent);
  mount('bob');
  expect(draft.draft).toEqual({});
  draft.update({ prompt: 'Bob' });
  mount('alice', 'other');
  expect(draft.draft).toEqual({});
  mount();
  expect(draft.draft).toEqual(intent);
  // Clearing an acknowledged field retains independent context and title edits.
  draft.update({ prompt: '', title: undefined });
  mount('bob');
  expect(draft.draft.prompt).toBe('Bob');
  mount();
  expect(draft.draft).toEqual({
    prompt: '',
    model: 'mock',
    references: ['b', 'a'],
    continueFrom: 'branch',
  });
});
it('retains edits in memory and reports unavailable storage', () => {
  mount();
  const failure = vi.spyOn(storage, 'setItem').mockImplementation(() => {
    throw new Error('quota');
  });
  draft.update({ prompt: 'Do not lose this' });
  expect(draft.draft.prompt).toBe('Do not lose this');
  expect(draft.error).toContain('Keep this tab open');
  failure.mockRestore();
});
it('rejects malformed recovered context rather than feeding it into submission', () => {
  storage.setItem(
    JSON.stringify(['mem-brane-workspace-draft', 1, 'alice', 'research']),
    JSON.stringify({ references: [3] }),
  );
  mount();
  expect(draft.draft).toEqual({});
  expect(draft.error).toContain('recovery is unavailable');
});
