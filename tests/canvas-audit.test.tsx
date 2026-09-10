// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BraneState } from '../shared/types/domain';
import { BraneCanvas } from '../src/canvas/BraneCanvas';
import { useInteraction } from '../src/stores/interaction';
import { WorkspaceDocument } from '../src/services/workspace-document';
let root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  useInteraction.setState({ selectedPlacements: [], tool: 'select' });
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});
const noop = () => {};
const state: BraneState = {
  brane: { id: 'b', title: 'test', created_at: 0, updated_at: 0 },
  blocks: [
    {
      id: 'a',
      kind: 'text',
      origin: 'authored',
      content: { format: 'text', text: 'a' },
      version: 0,
    },
  ],
  placements: ['pa', 'pa2'].map((id, i) => ({
    id,
    block_id: 'a',
    brane_id: 'b',
    x: i * 400,
    y: 0,
    width: 320,
    height: 220,
    z_index: 0,
    version: 0,
  })),
  runs: [],
  derivations: [],
};
const workspace = new WorkspaceDocument();
function render(s = state) {
  act(() => workspace.install(s));
  act(() =>
    root.render(
      <StrictMode>
        <BraneCanvas
          onContext={noop}
          onContinue={noop}
          document={workspace}
          onSpawn={noop}
          onCreate={noop}
          onEdit={noop}
          onGeometry={noop}
          onFocus={noop}
          onManage={noop}
        />
      </StrictMode>,
    ),
  );
}
it('projects independent placement selection across remounts without feedback', () => {
  useInteraction.getState().setSelectedPlacements(['pa2']);
  render();
  expect(document.querySelector('.react-flow__node.selected')?.getAttribute('data-id')).toBe('pa2');
  act(() => root.render(<div>Focus</div>));
  render();
  expect(useInteraction.getState().selectedPlacements).toEqual(['pa2']);
  expect(document.querySelector('.react-flow__node.selected')?.getAttribute('data-id')).toBe('pa2');
});
it('prunes a removed placement without deselecting its surviving duplicate', () => {
  useInteraction.getState().setSelectedPlacements(['pa', 'pa2']);
  render();
  render({ ...state, placements: [state.placements[1]] });
  expect(useInteraction.getState().selectedPlacements).toEqual(['pa2']);
});
it('does not notify subscribers for equivalent selection sets', () => {
  useInteraction.getState().setSelectedPlacements(['pa2', 'pa']);
  const listener = vi.fn(),
    before = useInteraction.getState();
  const unsubscribe = useInteraction.subscribe(listener);
  useInteraction.getState().setSelectedPlacements(['pa', 'pa2', 'pa']);
  unsubscribe();
  expect(useInteraction.getState()).toBe(before);
  expect(listener).not.toHaveBeenCalled();
});
it('keeps cards pointer-interactive in Pan with movement and resize disabled', () => {
  useInteraction.setState({ tool: 'pan', selectedPlacements: ['pa'] });
  render();
  const node = document.querySelector<HTMLElement>('.react-flow__node')!;
  expect(node.style.pointerEvents).toBe('all');
  expect(document.querySelector('[data-resize]')).toBeNull();
});
