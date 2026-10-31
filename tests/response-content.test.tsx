// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ResponseContent } from '../src/components/ResponseContent';
import type { Run } from '../shared/types/domain';
let root: Root;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
});
function render(text: string, status: Run['status'], actions = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const run: Run = {
    id: 'run',
    brane_id: 'brane',
    status,
    model: 'deepseek-flash',
    provider: 'deepseek',
    output_block_id: 'block',
    partial: text,
    error: null,
    usage_json: null,
    retry_of: null,
    machine_block_id: null,
    machine_version: null,
    batch_id: null,
    batch_position: null,
    confirmed_microusd: null,
    created_at: 0,
  };
  act(() => root.render(<ResponseContent text="" run={run} {...actions} />));
  return host;
}
it('renders readable markdown without executing HTML, unsafe links, or remote images', () => {
  const host = render(
    '# Answer\n\n**Clear**\n\n- One\n- Two\n\n```js\nconst x = 1;\n```\n\n<script>alert(1)</script>\n\n[bad](javascript:alert)\n\n![tracking](https://example.com/track.png)',
    'completed',
  );
  expect(host.querySelector('h1')?.textContent).toBe('Answer');
  expect(host.querySelector('strong')?.textContent).toBe('Clear');
  expect(host.querySelectorAll('li')).toHaveLength(2);
  expect(host.querySelector('pre code')?.textContent).toContain('const x = 1;');
  expect(host.querySelector('script, img, a[href^="javascript:"]')).toBeNull();
});
it('keeps partial output and retries failed responses explicitly', async () => {
  const retry = vi.fn().mockResolvedValue(undefined);
  const host = render('Partial answer', 'failed', { onRetry: retry });
  expect(host.textContent).toContain('Response failed');
  expect(host.textContent).toContain('Partial answer');
  expect(host.textContent).not.toContain('Writing');
  await act(async () => {
    [...host.querySelectorAll('button')].find((b) => b.textContent === 'Try again')!.click();
  });
  expect(retry).toHaveBeenCalledExactlyOnceWith('run');
});
it('stops an active response from its own card', async () => {
  const stop = vi.fn().mockResolvedValue(undefined);
  const host = render('', 'running', { onStop: stop });
  expect(host.textContent).toContain('Writing…');
  await act(async () => host.querySelector('button')!.click());
  expect(stop).toHaveBeenCalledExactlyOnceWith('run');
});
