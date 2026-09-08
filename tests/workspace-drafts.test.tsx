// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useWorkspaceDraft } from '../src/services/workspace-drafts';

let root: Root;
let draft: ReturnType<typeof useWorkspaceDraft>;
function Editor({ actor, brane }: { actor: string; brane: string }) {
  draft = useWorkspaceDraft(actor, brane);
  return null;
}
function mount(actor = 'alice', brane = 'research') {
  if (!root) {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    root = createRoot(document.createElement('div'));
  }
  act(() =>
    root.render(<Editor key={JSON.stringify([actor, brane])} actor={actor} brane={brane} />),
  );
}
afterEach(() => {
  if (root) act(() => root.unmount());
  root = undefined!;
  vi.restoreAllMocks();
  sessionStorage.clear();
});
it('isolates accounts and workspaces and preserves ordered composer intent', () => {
  mount();
  const intent = {
    prompt: 'Compare',
    model: 'mock',
    references: ['b', 'a'],
    continueFrom: 'branch',
    title: 'Unfinished',
  };
  act(() => draft.update(intent));
  mount('bob');
  expect(draft.draft).toEqual({});
  act(() => draft.update({ prompt: 'Bob' }));
  mount('alice', 'other');
  expect(draft.draft).toEqual({});
  mount();
  expect(draft.draft).toEqual(intent);
  // Clearing an acknowledged field retains independent context and title edits.
  act(() => draft.update({ prompt: '', title: undefined }));
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
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota');
  });
  act(() => draft.update({ prompt: 'Do not lose this' }));
  expect(draft.draft.prompt).toBe('Do not lose this');
  expect(draft.error).toContain('Keep this tab open');
});
it('rejects malformed recovered context rather than feeding it into submission', () => {
  sessionStorage.setItem(
    JSON.stringify(['mem-brane-workspace-draft', 1, 'alice', 'research']),
    JSON.stringify({ references: [3] }),
  );
  mount();
  expect(draft.draft).toEqual({});
  expect(draft.error).toContain('recovery is unavailable');
});
