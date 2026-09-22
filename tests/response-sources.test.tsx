// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ResponseSources } from '../src/components/ResponseSources';
import { WorkspaceDocument } from '../src/services/workspace-document';
import type { BraneState, Derivation } from '../shared/types/domain';

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
});
const derivation = (patch: Partial<Derivation>): Derivation => ({
  runId: 'run',
  kind: 'reference',
  sourceBlockId: 'a',
  sourceRevisionId: 'rev-a',
  sourceVersion: 1,
  outputBlockId: 'out',
  position: 0,
  anchorPlacementId: null,
  outputPlacementId: null,
  ...patch,
});
const state = (versionA: number): BraneState => ({
  brane: { id: 'b', title: 'Sources', created_at: 0, updated_at: 0 },
  blocks: [
    {
      id: 'a',
      kind: 'text',
      origin: 'authored',
      version: versionA,
      content: { format: 'text', text: 'Field notes' },
    },
    {
      id: 'c',
      kind: 'text',
      origin: 'generated',
      version: 0,
      content: { format: 'text', text: '' },
      messageId: 'm',
    },
    {
      id: 'out',
      kind: 'text',
      origin: 'generated',
      version: 0,
      content: { format: 'text', text: 'Answer' },
    },
  ],
  placements: [],
  runs: [],
  derivations: [
    derivation({}),
    derivation({ sourceBlockId: 'c', sourceRevisionId: 'rev-c', sourceVersion: null, position: 1 }),
    derivation({ sourceBlockId: 'gone', sourceRevisionId: 'rev-g', position: 2 }),
  ],
});
it('labels ordered sources, marks only edited ones as changed, and offers an explicit rerun', () => {
  const document = new WorkspaceDocument();
  document.install(state(1));
  const handlers = { onOpenSource: vi.fn(), onInspect: vi.fn(), onRerun: vi.fn() };
  act(() => root.render(<ResponseSources document={document} blockId="out" {...handlers} />));
  const chips = () => Array.from(host.querySelectorAll<HTMLButtonElement>('.source-chip'));
  expect(chips().map((c) => c.textContent)).toEqual([
    '1 · Field notes',
    '2 · Response',
    '3 · Not on this brane',
  ]);
  expect(chips()[2].disabled).toBe(true);
  expect(host.textContent).not.toContain('Reuse with current sources');
  act(() => document.install(state(2)));
  expect(chips()[0].className).toContain('changed');
  expect(chips()[1].className).not.toContain('changed');
  const button = (name: string) =>
    Array.from(host.querySelectorAll('button')).find((b) => b.textContent === name)!;
  act(() => button('Reuse with current sources').click());
  act(() => button('Exact inputs').click());
  act(() => chips()[0].click());
  expect(handlers.onRerun).toHaveBeenCalledWith('run');
  expect(handlers.onInspect).toHaveBeenCalledWith('run');
  expect(handlers.onOpenSource).toHaveBeenCalledWith('a');
});
it('renders nothing for a response without recorded sources', () => {
  const document = new WorkspaceDocument();
  document.install({ ...state(1), derivations: [] });
  act(() =>
    root.render(
      <ResponseSources
        document={document}
        blockId="out"
        onOpenSource={() => {}}
        onInspect={() => {}}
        onRerun={() => {}}
      />,
    ),
  );
  expect(host.innerHTML).toBe('');
});
