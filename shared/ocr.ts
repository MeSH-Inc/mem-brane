import { z } from 'zod';

const pages = z.number().int().nonnegative().safe();
const identity = z.string().regex(/^[a-f0-9]{64}$/);
export const ocrCreditsSchema = z.object({
  grantedPages: pages,
  committedPages: pages,
  availablePages: pages,
});
export const ocrPolicySummarySchema = z.object({
  provider: z.string(),
  model: z.string(),
  version: z.string(),
});
export const ocrJobSchema = z.object({
  id: z.string().uuid(),
  assetId: z.string().uuid(),
  policyId: identity,
  policy: ocrPolicySummarySchema,
  status: z.enum(['queued', 'running', 'succeeded', 'uncertain', 'cancelled', 'failed']),
  pages: pages.positive().max(100),
  committedPages: pages,
  error: z.string().nullable(),
});
export const ocrAssetSchema = z.object({
  enabled: z.boolean(),
  currentPolicyId: identity.nullable(),
  credits: ocrCreditsSchema,
  job: ocrJobSchema.nullable(),
});
export const ocrQuoteSchema = z.object({
  policyId: identity,
  policy: ocrPolicySummarySchema,
  pages: pages.positive().max(100),
  requiredCredits: pages,
  job: ocrJobSchema.nullable(),
  credits: ocrCreditsSchema,
});
const coordinate = z.number().finite().min(0).max(1);
export const ocrDocumentSchema = z.object({
  version: z.literal('ocr-pages-v1'),
  pages: z
    .array(
      z.object({
        page: pages.positive().max(100),
        width: z.number().positive().finite(),
        height: z.number().positive().finite(),
        markdown: z.string().max(20000),
        blocks: z
          .array(
            z.object({
              id: z.string(),
              type: z.string(),
              text: z.string(),
              bbox: z
                .object({ x: coordinate, y: coordinate, width: coordinate, height: coordinate })
                .refine(
                  (b) => b.x + b.width <= 1.000001 && b.y + b.height <= 1.000001,
                  'Block exceeds page',
                ),
            }),
          )
          .max(2000),
      }),
    )
    .min(1)
    .max(100)
    .refine(
      (value) => value.every((p, i) => p.page === i + 1),
      'Pages must be complete and ordered',
    ),
});
export const ocrResultSchema = z.object({
  document: ocrDocumentSchema,
  evidence: z.object({
    provider: z.string(),
    model: z.string(),
    response: z.record(z.string(), z.unknown()),
  }),
});
export type OcrResult = z.infer<typeof ocrResultSchema>;
export type OcrJob = z.infer<typeof ocrJobSchema>;
export type OcrQuote = z.infer<typeof ocrQuoteSchema>;
export type OcrAsset = z.infer<typeof ocrAssetSchema>;
export type OcrDocument = z.infer<typeof ocrDocumentSchema>;
