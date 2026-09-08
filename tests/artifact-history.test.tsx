// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ArtifactActions } from '../src/components/ArtifactActions';
import { api } from '../src/services/api';
import type { RevisionPage } from '../shared/types/history';
vi.mock('../src/services/api', () => ({ api: vi.fn() }));
let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  document.body.innerHTML = '';
  vi.resetAllMocks();
});
const page = (text: string, nextCursor: string | null = null): RevisionPage => ({
  items: [{ id: text, block_id: 'a', created_at: 1, format: 'text', preview: text }],
  nextCursor,
});
it('appends older history and ignores an old page after switching blocks', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let finishOld!: (page: RevisionPage) => void;
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path === '/branes') return [];
    if (path === '/blocks/a/revisions') return page('Newest', 'older');
    if (path === '/blocks/a/revisions?cursor=older') return page('Older', 'oldest');
    if (path === '/blocks/a/revisions?cursor=oldest')
      return new Promise((resolve) => {
        finishOld = resolve;
      });
    if (path === '/blocks/b/revisions') return page('Different block');
    throw new Error(`Unexpected path ${path}`);
  });
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const render = (id: string) =>
    root!.render(
      <ArtifactActions
        block={{
          id,
          kind: 'text',
          origin: 'authored',
          version: 0,
          content: { format: 'text', text: '' },
        }}
        placements={[]}
        onChange={async () => {}}
        onSave={async () => {}}
        onGeometry={async () => {}}
        onClose={() => {}}
      />,
    );
  await act(async () => render('a'));
  const more = () =>
    Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'Load older snapshots',
    )!;
  expect(host.textContent).toContain('Newest');
  await act(async () => more().click());
  expect(host.querySelectorAll('pre')).toHaveLength(0);
  expect(host.textContent).toContain('Older');
  await act(async () => more().click());
  expect(more().disabled).toBe(true);
  await act(async () => render('b'));
  await act(async () => finishOld(page('Stale history')));
  expect(host.querySelectorAll('pre')).toHaveLength(0);
  expect(host.textContent).toContain('Different block');
  expect(more()).toBeUndefined();
});

it('fetches only the selected snapshot and fences a slower previous selection', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let finishFirst!: (value: unknown) => void;
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path === '/branes') return [];
    if (path === '/blocks/a/revisions')
      return { items: [...page('one').items, ...page('two').items], nextCursor: null };
    if (path === '/revisions/one')
      return new Promise((resolve) => {
        finishFirst = resolve;
      });
    if (path === '/revisions/two')
      return {
        id: 'two',
        block_id: 'a',
        created_at: 1,
        content: { format: 'text', text: 'Exact selected body' },
      };
    throw new Error(`Unexpected ${path}`);
  });
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <ArtifactActions
        block={{
          id: 'a',
          kind: 'text',
          origin: 'authored',
          version: 0,
          content: { format: 'text', text: '' },
        }}
        placements={[]}
        onChange={async () => {}}
        onSave={async () => {}}
        onGeometry={async () => {}}
        onClose={() => {}}
      />,
    ),
  );
  expect(vi.mocked(api).mock.calls.filter(([path]) => path.startsWith('/revisions/'))).toHaveLength(
    0,
  );
  const choose = (name: string) =>
    Array.from(host.querySelectorAll('button'))
      .find((b) => b.textContent?.endsWith(`· ${name}`))!
      .click();
  await act(async () => choose('one'));
  await act(async () => choose('two'));
  expect(host.querySelector('pre')?.textContent).toBe('Exact selected body');
  await act(async () =>
    finishFirst({
      id: 'one',
      block_id: 'a',
      created_at: 1,
      content: { format: 'text', text: 'Stale body' },
    }),
  );
  expect(host.querySelector('pre')?.textContent).toBe('Exact selected body');
  await act(async () => choose('two'));
  expect(host.querySelectorAll('pre')).toHaveLength(0);
});
