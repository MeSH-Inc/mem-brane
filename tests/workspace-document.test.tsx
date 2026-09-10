// @vitest-environment jsdom
import { act, Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import type { BraneState } from '../shared/types/domain';
import { WorkspaceDocument } from '../src/services/workspace-document';
import { LiveBlockContent } from '../src/components/LiveBlockContent';
const state: BraneState = {
  brane: { id: 'brane', title: 'test', created_at: 0, updated_at: 0 },
  blocks: [
    {
      id: 'a',
      kind: 'text',
      origin: 'authored',
      version: 0,
      content: { format: 'text', text: 'A' },
    },
    {
      id: 'b',
      kind: 'text',
      origin: 'generated',
      version: 0,
      content: { format: 'text', text: '' },
    },
  ],
  placements: ['a', 'b'].map((id, i) => ({
    id: 'p' + id,
    block_id: id,
    brane_id: 'brane',
    x: i * 400,
    y: 100,
    width: 300,
    height: 220,
    version: 0,
    z_index: 0,
  })),
  runs: [
    {
      id: 'run',
      brane_id: 'brane',
      output_block_id: 'b',
      status: 'running',
      partial: 'first',
      model: 'mock',
      provider: 'mock',
      error: null,
      usage_json: null,
      retry_of: null,
      created_at: 0,
    },
  ],
  derivations: [],
};
it('reuses equal refreshes and keeps scene identity during content, stream and command changes', () => {
  const doc = new WorkspaceDocument();
  doc.install(state);
  const before = doc.store.getState();
  doc.install(structuredClone(state));
  expect(doc.store.getState()).toBe(before);
  doc.install({ ...state, runs: [{ ...state.runs[0], partial: 'second' }] });
  expect(doc.store.getState().scene).toBe(before.scene);
  expect(doc.store.getState().blocks.a).toBe(before.blocks.a);
  doc.activity(['b'], []);
  expect(doc.store.getState().scene).toBe(before.scene);
});
it('streams one block without committing a render in an unrelated editor', () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const doc = new WorkspaceDocument();
  doc.install(state);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host),
    commits: string[] = [];
  try {
    act(() =>
      root.render(
        <>
          {['a', 'b'].map((id) => (
            <Profiler key={id} id={id} onRender={(id) => commits.push(id)}>
              <LiveBlockContent document={doc} blockId={id} onEdit={() => {}} />
            </Profiler>
          ))}
        </>,
      ),
    );
    commits.length = 0;
    act(() => doc.install({ ...state, runs: [{ ...state.runs[0], partial: 'second' }] }));
    expect(host.textContent).toContain('second');
    expect(commits).toEqual(['b']);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
