import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { ocrResultSchema, type OcrResult } from '../../shared/ocr.js';
import { canonicalJson } from '../domain/canonical.js';
import { ocrPolicySchema, type OcrPolicy, type OcrProvider } from '../services/ocr.js';

// Verified 2026-09-11 against https://docs.mistral.ai/models/ocr-4-1
// Standard synchronous OCR costs $4/1,000 pages. No annotation or batch pricing.
export const mistralOcrModel = 'mistral-ocr-4-1';
const endpoint = 'https://api.mistral.ai/v1/ocr';
const defaultResponseBytes = 10 * 1024 * 1024;
const requestOptions = Object.freeze({
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
const index = z.number().int().nonnegative();
const blockSchema = z.object({
  type: z.enum([
    'text',
    'title',
    'list',
    'table',
    'image',
    'equation',
    'caption',
    'code',
    'references',
    'aside_text',
    'header',
    'footer',
    'signature',
  ]),
  content: z.string().max(20000),
  top_left_x: index,
  top_left_y: index,
  bottom_right_x: index,
  bottom_right_y: index,
});
// See https://docs.mistral.ai/openapi.yaml and /studio/document-processing/basic_ocr.
// Keep raw evidence separately; this schema validates only fields we consume.
const responseSchema = z.object({
  model: z.literal(mistralOcrModel),
  usage_info: z.object({
    pages_processed: index,
    doc_size_bytes: index.nullish(),
  }),
  pages: z
    .array(
      z.object({
        index: index.max(99),
        markdown: z.string().max(20000),
        dimensions: z.object({ width: index.positive(), height: index.positive() }),
        blocks: z.array(blockSchema).max(2000),
      }),
    )
    .min(1)
    .max(100),
});

async function readBounded(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<unknown> {
  if (!response.body) throw new Error('OCR response body is missing');
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    signal.throwIfAborted();
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit))
      throw new Error('OCR response exceeds the byte limit');
    while (true) {
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) throw new Error('OCR response exceeds the byte limit');
      chunks.push(part.value);
    }
    try {
      // Fatal decoding prevents replacement characters from silently changing evidence.
      const json = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
      return JSON.parse(json) as unknown;
    } catch {
      throw new Error('OCR response is not valid UTF-8 JSON');
    }
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function normalize(raw: unknown, pages: number, inputBytes: number): OcrResult {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) throw new Error('OCR response does not match the pinned model contract');
  const response = parsed.data;
  if (
    response.usage_info.pages_processed !== pages ||
    response.pages.length !== pages ||
    response.pages.some((page, i) => page.index !== i) ||
    (response.usage_info.doc_size_bytes != null &&
      response.usage_info.doc_size_bytes !== inputBytes)
  )
    throw new Error('OCR response does not confirm every requested page and document');
  const normalized = ocrResultSchema.safeParse({
    document: {
      version: 'ocr-pages-v1',
      pages: response.pages.map((page) => {
        const { width, height } = page.dimensions;
        if (page.markdown.trim() && page.blocks.length === 0)
          throw new Error('OCR response omitted blocks for a nonempty page');
        return {
          page: page.index + 1,
          width,
          height,
          markdown: page.markdown,
          blocks: page.blocks.map((block, i) => {
            if (
              block.bottom_right_x <= block.top_left_x ||
              block.bottom_right_y <= block.top_left_y ||
              block.bottom_right_x > width ||
              block.bottom_right_y > height
            )
              throw new Error('OCR response contains invalid block coordinates');
            return {
              id: `p${page.index + 1}-b${i + 1}`,
              type: block.type,
              text: block.content,
              bbox: {
                x: block.top_left_x / width,
                y: block.top_left_y / height,
                width: (block.bottom_right_x - block.top_left_x) / width,
                height: (block.bottom_right_y - block.top_left_y) / height,
              },
            };
          }),
        };
      }),
    },
    evidence: { provider: 'mistral', model: response.model, response: raw },
  });
  if (!normalized.success)
    throw new Error('OCR response cannot be normalized without losing content');
  return normalized.data;
}

export function createMistralOcrProvider({
  apiKey,
  fetch: fetchRequest = globalThis.fetch,
  maxResponseBytes = defaultResponseBytes,
}: {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  maxResponseBytes?: number;
}): OcrProvider {
  if (!apiKey || /\s/.test(apiKey)) throw new Error('An explicit Mistral API key is required');
  z.number().int().positive().max(defaultResponseBytes).parse(maxResponseBytes);
  const policy: OcrPolicy = Object.freeze({
    provider: 'mistral',
    model: mistralOcrModel,
    version: '4.1',
    microusdPerPage: 4000,
    priceSource: 'https://docs.mistral.ai/models/ocr-4-1',
    verifiedAt: '2026-09-11',
    options: Object.freeze({
      endpoint,
      request: requestOptions,
      pages: 'all-in-input-order',
      normalization: Object.freeze({
        version: 'ocr-pages-v1',
        coordinates: 'unit-square',
        pageNumbering: 'one-based',
        maxPageCharacters: 20000,
        maxBlocksPerPage: 2000,
      }),
      maxResponseBytes,
      transportRetries: 0,
      pricing: 'standard-synchronous-without-annotations',
    }),
  });
  const identity = canonicalJson(policy);
  return {
    policy,
    async parse(request) {
      request.signal.throwIfAborted();
      z.number().int().min(1).max(100).parse(request.pages);
      if (!request.bytes.byteLength) throw new Error('OCR document is empty');
      if (canonicalJson(ocrPolicySchema.parse(request.policy)) !== identity)
        throw new Error('OCR policy differs from the pinned provider policy');
      // Exactly one transport call. A redirect is also a failed attempt, never a second dispatch.
      const response = await fetchRequest(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: request.signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: mistralOcrModel,
          document: {
            type: 'document_url',
            document_url: `data:application/pdf;base64,${Buffer.from(request.bytes).toString('base64')}`,
          },
          pages: Array.from({ length: request.pages }, (_, i) => i),
          ...requestOptions,
        }),
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new Error(`OCR provider returned HTTP ${response.status}`);
      }
      const raw = await readBounded(response, maxResponseBytes, request.signal);
      const result = normalize(raw, request.pages, request.bytes.byteLength);
      // The result includes both evidence and normalization, which can exceed the wire body.
      if (Buffer.byteLength(JSON.stringify(result)) > maxResponseBytes)
        throw new Error('OCR normalized result exceeds the byte limit');
      return { billedPages: request.pages, result };
    },
  };
}
