// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { it, expect, vi } from 'vitest';
import { PdfContent } from '../src/components/PdfContent';
import { api } from '../src/services/api';
import type { PdfSummary } from '../shared/types/domain';
vi.mock('../src/services/api', () => ({ api: vi.fn() }));
it('loads page text only on demand, retries failure and fences an obsolete identity', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'),
    root = createRoot(host);
  const summary = (id: string): PdfSummary => ({
    format: 'pdf',
    text: 'Paper',
    filename: 'Paper.pdf',
    assetId: 'a',
    assetHash: 'hash',
    mimeType: 'application/pdf',
    pageCount: 1,
    representationId: id,
    representation: { kind: 'pdf-text-v1', extractor: 'fixture', status: 'ready' },
  });
  let complete!: (value: unknown) => void;
  vi.mocked(api)
    .mockRejectedValueOnce(new Error('Unavailable'))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
  try {
    await act(async () => root.render(<PdfContent content={summary('one')} />));
    expect(api).not.toHaveBeenCalled();
    await act(async () => host.querySelector('button')!.click());
    expect(host.textContent).toContain('Unavailable');
    await act(async () => host.querySelector('button')!.click());
    expect(api).toHaveBeenCalledTimes(2);
    await act(async () => root.render(<PdfContent content={summary('two')} />));
    await act(async () =>
      complete({
        kind: 'pdf-text-v1',
        extractor: 'fixture',
        status: 'ready',
        pages: [{ number: 1, text: 'Obsolete text' }],
      }),
    );
    expect(host.textContent).not.toContain('Obsolete text');
    expect(host.textContent).toContain('Load page text');
  } finally {
    act(() => root.unmount());
    vi.resetAllMocks();
  }
});
