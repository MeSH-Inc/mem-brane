// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BraneState } from '../shared/types/domain';
import { BraneCanvas } from '../src/canvas/BraneCanvas';
import { useInteraction } from '../src/stores/interaction';
// React Flow is real; the wrapper only exposes its store. Layout observation is stubbed.
const probe = vi.hoisted(() => ({ store: null as any }));
vi.mock('@xyflow/react', async (original) => {
  const actual = await original<typeof import('@xyflow/react')>();
  return {
    ...actual,
    ReactFlow: (props: any) => {
      probe.store = actual.useStoreApi();
      return <actual.ReactFlow {...props} />;
    },
  };
});
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
  useInteraction.setState({ selectedPlacements: [] });
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
    {
      id: 'b',
      kind: 'text',
      origin: 'authored',
      content: { format: 'text', text: 'b' },
      version: 0,
    },
  ],
  placements: ['a', 'b'].map((id, i) => ({
    id: 'p' + id,
    block_id: id,
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
function render(s = state, onGeometry = noop) {
  act(() =>
    root.render(
      <StrictMode>
        <BraneCanvas
          onContext={() => {}}
          onContinue={() => {}}
          state={s}
          spawning={[]}
          retrySpawns={[]}
          onSpawn={noop}
          onCreate={noop}
          onEdit={noop}
          onGeometry={onGeometry}
          onFocus={noop}
          onManage={noop}
        />
      </StrictMode>,
    ),
  );
}
it('settles after normal React Flow selection', () => {
  render();
  act(() => probe.store.getState().addSelectedNodes(['pa']));
  expect(useInteraction.getState().selectedPlacements).toEqual(['pa']);
});
it('preserves external selection without a feedback loop', () => {
  render();
  act(() => useInteraction.getState().setSelectedPlacements(['pa']));
  expect(useInteraction.getState().selectedPlacements).toEqual(['pa']);
  expect(probe.store.getState().nodeLookup.get('pa').selected).toBe(true);
});
it('mounts with retained selection', () => {
  useInteraction.getState().setSelectedPlacements(['pa']);
  render();
  expect(useInteraction.getState().selectedPlacements).toEqual(['pa']);
  expect(probe.store.getState().nodeLookup.get('pa').selected).toBe(true);
});
it('settles after selecting one of two placements of the same block', () => {
  render({
    ...state,
    placements: [...state.placements, { ...state.placements[0], id: 'pa2', x: 800 }],
  });
  act(() => probe.store.getState().addSelectedNodes(['pa']));
  expect(useInteraction.getState().selectedPlacements).toEqual(['pa']);
});

it('retains selection across actual canvas unmount and remount', () => {
  render();
  act(() => probe.store.getState().addSelectedNodes(['pa']));
  expect(useInteraction.getState().selectedPlacements).toEqual(['pa']);
  act(() => root.render(<div>Focus view</div>));
  render();
  expect(useInteraction.getState().selectedPlacements).toEqual(['pa']);
  expect(probe.store.getState().nodeLookup.get('pa').selected).toBe(true);
});
it('settles after removing the selected placement', () => {
  render();
  act(() => probe.store.getState().addSelectedNodes(['pa']));
  render({ ...state, placements: [state.placements[1]] });
  expect(useInteraction.getState().selectedPlacements).toEqual([]);
});

it('does not notify subscribers for equivalent selection sets', () => {
  useInteraction.getState().setSelectedPlacements(['pb', 'pa']);
  const listener = vi.fn();
  const before = useInteraction.getState();
  const unsubscribe = useInteraction.subscribe(listener);
  useInteraction.getState().setSelectedPlacements(['pa', 'pb', 'pa']);
  unsubscribe();
  expect(useInteraction.getState()).toBe(before);
  expect(listener).not.toHaveBeenCalled();
});
it('handles multi-selection and explicit deselection', () => {
  render();
  act(() => probe.store.getState().addSelectedNodes(['pa', 'pb']));
  expect(useInteraction.getState().selectedPlacements).toEqual(['pa', 'pb']);
  act(() =>
    probe.store.getState().triggerNodeChanges([{ id: 'pa', type: 'select', selected: false }]),
  );
  expect(useInteraction.getState().selectedPlacements).toEqual(['pb']);
});
it('preserves in-progress resize through content updates and commits once', () => {
  const save = vi.fn();
  render(state, save);
  act(() =>
    probe.store.getState().triggerNodeChanges([
      { id: 'pa', type: 'position', position: { x: 20, y: 30 } },
      {
        id: 'pa',
        type: 'dimensions',
        dimensions: { width: 500, height: 350 },
        resizing: true,
        setAttributes: true,
      },
    ]),
  );
  render(
    {
      ...state,
      blocks: state.blocks.map((b) => ({
        ...b,
        content: { format: 'text', text: 'updated during resize' },
      })),
    },
    save,
  );
  const node = probe.store.getState().nodeLookup.get('pa');
  expect(node.width).toBe(500);
  expect(node.position).toEqual({ x: 20, y: 30 });
  expect(node.data.block.content.text).toBe('updated during resize');
  expect(save).not.toHaveBeenCalled();
  act(() =>
    probe.store
      .getState()
      .triggerNodeChanges([
        { id: 'pa', type: 'dimensions', dimensions: { width: 500, height: 350 }, resizing: false },
      ]),
  );
  expect(save).toHaveBeenCalledExactlyOnceWith('pa', { x: 20, y: 30, width: 500, height: 350 });
});
it('persists keyboard moves and each node in a completed multi-drag', () => {
  const save = vi.fn();
  render(state, save);
  act(() =>
    probe.store
      .getState()
      .triggerNodeChanges([
        { id: 'pa', type: 'position', position: { x: 10, y: 20 }, dragging: false },
      ]),
  );
  expect(save).toHaveBeenCalledExactlyOnceWith('pa', { x: 10, y: 20, width: 320, height: 220 });
  save.mockClear();
  act(() =>
    probe.store.getState().triggerNodeChanges([
      { id: 'pa', type: 'position', position: { x: 50, y: 60 }, dragging: true },
      { id: 'pb', type: 'position', position: { x: 450, y: 60 }, dragging: true },
    ]),
  );
  expect(save).not.toHaveBeenCalled();
  act(() =>
    probe.store.getState().triggerNodeChanges([
      { id: 'pa', type: 'position', dragging: false },
      { id: 'pb', type: 'position', dragging: false },
    ]),
  );
  expect(save).toHaveBeenCalledTimes(2);
  expect(save).toHaveBeenCalledWith('pa', { x: 50, y: 60, width: 320, height: 220 });
  expect(save).toHaveBeenCalledWith('pb', { x: 450, y: 60, width: 320, height: 220 });
});
it('does not persist measurement notifications', () => {
  const save = vi.fn();
  render(state, save);
  act(() =>
    probe.store
      .getState()
      .triggerNodeChanges([
        { id: 'pa', type: 'dimensions', dimensions: { width: 320, height: 220 } },
      ]),
  );
  expect(save).not.toHaveBeenCalled();
});

it('keeps duplicate placements consistent when selection moves between them', () => {
  render({
    ...state,
    placements: [...state.placements, { ...state.placements[0], id: 'pa2', x: 800 }],
  });
  act(() => probe.store.getState().addSelectedNodes(['pa']));
  act(() => probe.store.getState().addSelectedNodes(['pa2']));
  expect(useInteraction.getState().selectedPlacements).toEqual(['pa2']);
  expect(probe.store.getState().nodeLookup.get('pa').selected).toBe(false);
  expect(probe.store.getState().nodeLookup.get('pa2').selected).toBe(true);
});

it('prunes only the removed placement when another copy of its block remains', () => {
  render({ ...state, placements: [...state.placements, { ...state.placements[0], id: 'pa2' }] });
  act(() => useInteraction.getState().setSelectedPlacements(['pa', 'pa2']));
  render({ ...state, placements: [{ ...state.placements[0], id: 'pa2' }, state.placements[1]] });
  expect(useInteraction.getState().selectedPlacements).toEqual(['pa2']);
});
