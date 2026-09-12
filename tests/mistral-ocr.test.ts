import { expect, it, vi } from 'vitest';
import { createMistralOcrProvider, mistralOcrModel } from '../server/ingestion/mistral-ocr';
import type { OcrProvider } from '../server/services/ocr';

const bytes = new TextEncoder().encode('%PDF-1.7 fixture');
function fixture(pages = 2) {
  return {
    model: mistralOcrModel,
    usage_info: { pages_processed: pages, doc_size_bytes: bytes.byteLength },
    pages: Array.from({ length: pages }, (_, index) => ({
      index,
      markdown: `# Page ${index + 1}\n\nA paragraph`,
      images: [],
      dimensions: { width: 1000, height: 2000, dpi: 200 },
      blocks: [
        {
          type: 'title',
          content: `Page ${index + 1}`,
          top_left_x: 100,
          top_left_y: 200,
          bottom_right_x: 900,
          bottom_right_y: 400,
        },
      ],
    })),
    document_annotation: null,
    future_provider_metadata: { receipt: 'preserve-this' },
  };
}
function setup(response: () => Response | Promise<Response> = () => Response.json(fixture())) {
  const fetchRequest = vi.fn<typeof fetch>(async () => response());
  const provider = createMistralOcrProvider({ apiKey: 'fixture-secret', fetch: fetchRequest });
  const request = (changes: Partial<Parameters<OcrProvider['parse']>[0]> = {}) => ({
    bytes,
    pages: 2,
    policy: provider.policy,
    jobId: 'fixture-job',
    signal: new AbortController().signal,
    ...changes,
  });
  return { fetchRequest, provider, request };
}

it('dispatches exactly one pinned, standard-price request with the original PDF bytes and full page range', async () => {
  const { provider, fetchRequest, request } = setup();
  const input = request();
  const output = await provider.parse(input);
  expect(fetchRequest).toHaveBeenCalledTimes(1);
  const [url, init] = fetchRequest.mock.calls[0];
  expect(url).toBe('https://api.mistral.ai/v1/ocr');
  expect(init).toMatchObject({
    method: 'POST',
    redirect: 'error',
    signal: input.signal,
    headers: { Authorization: 'Bearer fixture-secret', 'Content-Type': 'application/json' },
  });
  expect(JSON.parse(init!.body as string)).toEqual({
    model: 'mistral-ocr-4-1',
    document: {
      type: 'document_url',
      document_url: `data:application/pdf;base64,${Buffer.from(bytes).toString('base64')}`,
    },
    pages: [0, 1],
    include_blocks: true,
    include_image_base64: false,
    image_limit: null,
    image_min_size: null,
    table_format: null,
    extract_header: false,
    extract_footer: false,
    confidence_scores_granularity: null,
    bbox_annotation_format: null,
    document_annotation_format: null,
    document_annotation_prompt: null,
  });
  expect(provider.policy).toMatchObject({
    provider: 'mistral',
    model: 'mistral-ocr-4-1',
    version: '4.1',
    microusdPerPage: 4000,
    priceSource: 'https://docs.mistral.ai/models/ocr-4-1',
    verifiedAt: '2026-09-11',
    options: {
      maxResponseBytes: 10 * 1024 * 1024,
      transportRetries: 0,
      normalization: { version: 'ocr-pages-v1', coordinates: 'unit-square' },
    },
  });
  expect(Object.isFrozen(provider.policy.options)).toBe(true);
  expect(Object.isFrozen(provider.policy.options.request)).toBe(true);
  expect(output.billedPages).toBe(2);
  expect(output.result).toMatchObject({
    document: {
      version: 'ocr-pages-v1',
      pages: [
        {
          page: 1,
          width: 1000,
          height: 2000,
          markdown: '# Page 1\n\nA paragraph',
          blocks: [
            {
              id: 'p1-b1',
              type: 'title',
              text: 'Page 1',
              bbox: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 },
            },
          ],
        },
        { page: 2, blocks: [{ id: 'p2-b1' }] },
      ],
    },
    evidence: { provider: 'mistral', model: mistralOcrModel, response: fixture() },
  });
});

it.each([
  ['latest alias', (r: ReturnType<typeof fixture>) => (r.model = 'mistral-ocr-latest')],
  ['different exact model', (r: ReturnType<typeof fixture>) => (r.model = 'mistral-ocr-4-0')],
  ['unbilled pages', (r: ReturnType<typeof fixture>) => (r.usage_info.pages_processed = 1)],
  ['overbilled pages', (r: ReturnType<typeof fixture>) => (r.usage_info.pages_processed = 3)],
  ['fractional billing', (r: ReturnType<typeof fixture>) => (r.usage_info.pages_processed = 1.5)],
  ['wrong document size', (r: ReturnType<typeof fixture>) => (r.usage_info.doc_size_bytes = 1)],
  ['missing page', (r: ReturnType<typeof fixture>) => r.pages.pop()],
  ['duplicate index', (r: ReturnType<typeof fixture>) => (r.pages[1].index = 0)],
  ['out-of-order pages', (r: ReturnType<typeof fixture>) => r.pages.reverse()],
  ['nonzero first index', (r: ReturnType<typeof fixture>) => (r.pages[0].index = 2)],
  ['missing blocks', (r: ReturnType<typeof fixture>) => (r.pages[0].blocks = [])],
  ['unknown block type', (r: ReturnType<typeof fixture>) => (r.pages[0].blocks[0].type = 'alien')],
  [
    'negative coordinates',
    (r: ReturnType<typeof fixture>) => (r.pages[0].blocks[0].top_left_x = -1),
  ],
  [
    'reversed coordinates',
    (r: ReturnType<typeof fixture>) => (r.pages[0].blocks[0].bottom_right_y = 0),
  ],
  [
    'off-page coordinates',
    (r: ReturnType<typeof fixture>) => (r.pages[0].blocks[0].bottom_right_x = 1001),
  ],
  ['missing dimensions', (r: ReturnType<typeof fixture>) => (r.pages[0].dimensions.width = 0)],
  ['oversized page', (r: ReturnType<typeof fixture>) => (r.pages[0].markdown = 'x'.repeat(20001))],
])('rejects %s without a retry or a success result', async (_, change) => {
  const raw = fixture();
  change(raw);
  const { provider, fetchRequest, request } = setup(() => Response.json(raw));
  await expect(provider.parse(request())).rejects.toThrow();
  expect(fetchRequest).toHaveBeenCalledTimes(1);
});

it.each([
  {},
  { model: mistralOcrModel, pages: fixture().pages },
  { ...fixture(), usage_info: null },
])('requires explicit usage evidence: %j', async (raw) => {
  const { provider, fetchRequest, request } = setup(() => Response.json(raw));
  await expect(provider.parse(request())).rejects.toThrow('pinned model contract');
  expect(fetchRequest).toHaveBeenCalledTimes(1);
});

it('preserves an empty page and its confirmed billing', async () => {
  const raw = fixture();
  raw.pages[1].markdown = '';
  raw.pages[1].blocks = [];
  const { provider, request } = setup(() => Response.json(raw));
  await expect(provider.parse(request())).resolves.toMatchObject({
    billedPages: 2,
    result: { document: { pages: [{ page: 1 }, { page: 2, markdown: '', blocks: [] }] } },
  });
});

it.each(['not JSON', '{', '[{}]'])('rejects malformed response %s', async (body) => {
  const { provider, fetchRequest, request } = setup(() => new Response(body));
  await expect(provider.parse(request())).rejects.toThrow();
  expect(fetchRequest).toHaveBeenCalledTimes(1);
});

it('rejects malformed UTF-8 without substituting evidence characters', async () => {
  const { provider, request } = setup(() => new Response(new Uint8Array([0xff])));
  await expect(provider.parse(request())).rejects.toThrow('UTF-8 JSON');
});

it.each([401, 429, 500, 503])(
  'retains HTTP %i as one failed attempt without exposing its body',
  async (status) => {
    const cancel = vi.fn();
    const { provider, fetchRequest, request } = setup(
      () => new Response(new ReadableStream({ cancel }), { status }),
    );
    await expect(provider.parse(request())).rejects.toThrow(`OCR provider returned HTTP ${status}`);
    expect(fetchRequest).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  },
);

it('does not retry transport failures', async () => {
  const failure = new TypeError('fixture network failure');
  const { provider, fetchRequest, request } = setup(() => Promise.reject(failure));
  await expect(provider.parse(request())).rejects.toBe(failure);
  expect(fetchRequest).toHaveBeenCalledTimes(1);
});

it('cancels a streamed response at the byte bound even when Content-Length understates it', async () => {
  const cancel = vi.fn();
  const fetchRequest = vi.fn<typeof fetch>(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(60));
            controller.enqueue(new Uint8Array(60));
          },
          cancel,
        }),
        { headers: { 'Content-Length': '1' } },
      ),
  );
  const provider = createMistralOcrProvider({
    apiKey: 'fixture-key',
    fetch: fetchRequest,
    maxResponseBytes: 100,
  });
  await expect(
    provider.parse({
      bytes,
      pages: 2,
      policy: provider.policy,
      jobId: 'job',
      signal: AbortSignal.timeout(1000),
    }),
  ).rejects.toThrow('byte limit');
  expect(fetchRequest).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('rejects advertised overflow before reading and cancels the body', async () => {
  const cancel = vi.fn();
  const { provider, request } = setup(
    () =>
      new Response(new ReadableStream({ cancel }), { headers: { 'Content-Length': '10485761' } }),
  );
  await expect(provider.parse(request())).rejects.toThrow('byte limit');
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('bounds evidence plus normalized result as well as the wire response', async () => {
  const raw = fixture();
  const fetchRequest = vi.fn<typeof fetch>(async () => Response.json(raw));
  const provider = createMistralOcrProvider({
    apiKey: 'fixture-key',
    fetch: fetchRequest,
    maxResponseBytes: Buffer.byteLength(JSON.stringify(raw)) + 10,
  });
  await expect(
    provider.parse({
      bytes,
      pages: 2,
      policy: provider.policy,
      jobId: 'job',
      signal: AbortSignal.timeout(1000),
    }),
  ).rejects.toThrow('normalized result exceeds');
  expect(fetchRequest).toHaveBeenCalledTimes(1);
});

it('propagates pre-dispatch abort without sending anything', async () => {
  const { provider, request, fetchRequest } = setup();
  const reason = new Error('fixture cancellation');
  await expect(provider.parse(request({ signal: AbortSignal.abort(reason) }))).rejects.toBe(reason);
  expect(fetchRequest).not.toHaveBeenCalled();
});

it('propagates the abort signal to the single in-flight transport call', async () => {
  const controller = new AbortController();
  const reason = new Error('fixture cancellation');
  const fetchRequest = vi.fn<typeof fetch>(async (_url, init) => {
    expect(init?.signal).toBe(controller.signal);
    return new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      controller.abort(reason);
    });
  });
  const provider = createMistralOcrProvider({ apiKey: 'fixture-key', fetch: fetchRequest });
  await expect(
    provider.parse({
      bytes,
      pages: 2,
      policy: provider.policy,
      jobId: 'job',
      signal: controller.signal,
    }),
  ).rejects.toBe(reason);
  expect(fetchRequest).toHaveBeenCalledTimes(1);
});

it('cancels a pending stream read on abort even if the transport stream ignores the signal', async () => {
  const cancel = vi.fn();
  const controller = new AbortController();
  const reason = new Error('fixture cancellation');
  const { provider, request, fetchRequest } = setup(
    () =>
      new Response(
        new ReadableStream({ cancel, pull: () => controller.abort(reason) }, { highWaterMark: 0 }),
      ),
  );
  await expect(provider.parse(request({ signal: controller.signal }))).rejects.toBe(reason);
  expect(fetchRequest).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('rejects a changed policy before dispatch', async () => {
  const { provider, request, fetchRequest } = setup();
  await expect(
    provider.parse(request({ policy: { ...provider.policy, microusdPerPage: 1 } })),
  ).rejects.toThrow('differs from the pinned');
  expect(fetchRequest).not.toHaveBeenCalled();
});

it('requires an explicit valid API key and bounds its configuration', () => {
  expect(() => createMistralOcrProvider({ apiKey: '' })).toThrow('explicit');
  expect(() => createMistralOcrProvider({ apiKey: 'bad\nkey' })).toThrow('explicit');
  expect(() => createMistralOcrProvider({ apiKey: 'key', maxResponseBytes: 0 })).toThrow();
  expect(() => createMistralOcrProvider({ apiKey: 'key', maxResponseBytes: 10485761 })).toThrow();
});

it('propagates a mid-response stream failure without retrying the paid attempt', async () => {
  const failure = new Error('fixture broken stream');
  const { provider, request, fetchRequest } = setup(
    () =>
      new Response(
        new ReadableStream(
          {
            pull(controller) {
              controller.enqueue(new TextEncoder().encode('{'));
              controller.error(failure);
            },
          },
          { highWaterMark: 0 },
        ),
      ),
  );
  await expect(provider.parse(request())).rejects.toBe(failure);
  expect(fetchRequest).toHaveBeenCalledTimes(1);
});
