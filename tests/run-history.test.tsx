// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { RunHistory } from '../src/components/RunHistory';
import { api } from '../src/services/api';
vi.mock('../src/services/api', () => ({ api: vi.fn() }));
it('loads earlier responses only on demand, skips ones already listed, and opens their inputs', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const row = (id: string) => ({
    id,
    brane_id: 'b',
    model: 'mock',
    provider: 'mock',
    status: 'completed',
    created_at: 0,
    output_block_id: 'output',
    error: null,
    usage_json: null,
    retry_of: null,
  });
  vi.mocked(api).mockImplementation(async (path) =>
    path.endsWith('?cursor=older')
      ? { items: [row('old')], nextCursor: null }
      : { items: [row('live'), row('new')], nextCursor: 'older' },
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host),
    inspect = vi.fn(async () => {});
  try {
    await act(async () =>
      root.render(<RunHistory braneId="b" exclude={['live']} onInspect={inspect} />),
    );
    expect(api).not.toHaveBeenCalled();
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((b) => b.textContent === 'Show earlier responses')!
        .click(),
    );
    expect(api).toHaveBeenCalledWith('/branes/b/runs', undefined, undefined);
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((b) => b.textContent === 'Load more')!
        .click(),
    );
    expect(host.querySelectorAll('li')).toHaveLength(2);
    await act(async () =>
      host
        .querySelectorAll('li button')[1]
        .dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(inspect).toHaveBeenCalledWith('old');
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.resetAllMocks();
  }
});
