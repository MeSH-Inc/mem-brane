// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { EnhancedPdf } from '../src/components/EnhancedPdf';
import { client } from '../src/services/client';
import type { OcrAsset, OcrJob } from '../shared/ocr';
vi.mock('../src/services/client', () => ({
  client: {
    ocrAsset: vi.fn(),
    ocrQuote: vi.fn(),
    ocrJob: vi.fn(),
    ocrResult: vi.fn(),
    ocrSubmit: vi.fn(),
  },
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement('div');
let root = createRoot(host);
afterEach(() => {
  act(() => root.unmount());
  root = createRoot(host);
  vi.resetAllMocks();
});
const oldJob: OcrJob = {
  id: 'job',
  assetId: 'asset',
  policyId: 'old',
  policy: { provider: 'test', model: 'old-model', version: '1' },
  status: 'cancelled',
  pages: 2,
  committedPages: 0,
  error: null,
};
const state: OcrAsset = {
  enabled: true,
  currentPolicyId: 'current',
  credits: { grantedPages: 50, committedPages: 0, availablePages: 50 },
  job: oldJob,
};
async function open() {
  await act(async () => {
    const details = host.querySelector('details')!;
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
}
it('offers a separately confirmed current parser when an older terminal job exists', async () => {
  vi.mocked(client.ocrAsset).mockResolvedValue(state);
  vi.mocked(client.ocrJob).mockResolvedValue(oldJob);
  vi.mocked(client.ocrQuote).mockResolvedValue({
    policyId: 'current',
    policy: { provider: 'test', model: 'new-model', version: '2' },
    pages: 2,
    requiredCredits: 2,
    credits: state.credits,
    job: null,
  });
  await act(async () => root.render(<EnhancedPdf assetId="asset" blockId="block" version={0} />));
  expect(client.ocrAsset).not.toHaveBeenCalled();
  await open();
  expect(host.textContent).toContain('A different parser is available');
  await act(async () =>
    [...host.querySelectorAll('button')]
      .find((b) => b.textContent === 'Review page credits')!
      .click(),
  );
  expect(host.textContent).toContain('Reserve 2 page credits');
  expect(client.ocrSubmit).not.toHaveBeenCalled();
  vi.mocked(client.ocrSubmit).mockResolvedValue({
    ...oldJob,
    status: 'queued',
    policyId: 'current',
  });
  await act(async () =>
    [...host.querySelectorAll('button')]
      .find((b) => b.textContent === 'Confirm 2 page credits')!
      .click(),
  );
  expect(client.ocrSubmit).toHaveBeenCalledExactlyOnceWith('asset', 'current');
});
it('fences an old asset response while a newly selected PDF loads', async () => {
  let resolveOld!: (value: OcrAsset) => void;
  vi.mocked(client.ocrAsset)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValueOnce({
      ...state,
      job: null,
      enabled: false,
      credits: { grantedPages: 7, committedPages: 0, availablePages: 7 },
    });
  await act(async () => root.render(<EnhancedPdf assetId="asset" blockId="block" version={0} />));
  await open();
  await act(async () =>
    root.render(<EnhancedPdf assetId="new-asset" blockId="new-block" version={0} />),
  );
  await act(async () => resolveOld(state));
  expect(host.textContent).toContain('7 page credits available');
  expect(host.textContent).not.toContain('50 page credits available');
  expect(client.ocrJob).not.toHaveBeenCalled();
});
