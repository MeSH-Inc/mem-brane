// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SpawnButton } from '../src/components/SpawnButton';
import type { Block } from '../shared/types/domain';
let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  document.body.innerHTML = '';
});
it('only permits ready sources, blocks duplicate clicks in flight, and allows recursive spawning after finalization', () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const spawn = vi.fn();
  const render = (block: Block, busy = false, retry = false) =>
    act(() =>
      root!.render(<SpawnButton block={block} busy={busy} retry={retry} onSpawn={spawn} />),
    );
  const source: Block = {
    id: 'source',
    kind: 'text',
    origin: 'authored',
    content: { format: 'text', text: 'Idea' },
    version: 0,
  };
  render(source);
  act(() => host.querySelector('button')!.click());
  expect(spawn).toHaveBeenCalledTimes(1);
  render(source, true);
  act(() => host.querySelector('button')!.click());
  expect(spawn).toHaveBeenCalledTimes(1);
  render({ ...source, origin: 'generated' });
  expect(host.querySelector('button')!.disabled).toBe(true);
  render({ ...source, origin: 'generated', messageId: 'finalized' });
  expect(host.querySelector('button')!.disabled).toBe(false);
  render({
    ...source,
    kind: 'webpage',
    content: { format: 'webpage', text: '', status: 'pending' },
  });
  expect(host.querySelector('button')!.disabled).toBe(true);
  render(source, false, true);
  expect(host.querySelector('button')!.textContent).toBe('Retry Spawn');
});
