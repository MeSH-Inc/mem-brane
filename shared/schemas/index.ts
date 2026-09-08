import { MAX_BLOCK_TEXT_CHARACTERS } from '../limits.js';
import { z } from 'zod';
export const id = z.string().uuid();
export const geometry = z.object({
  x: z.number().finite().min(-1e6).max(1e6),
  y: z.number().finite().min(-1e6).max(1e6),
  width: z.number().min(180).max(4000),
  height: z.number().min(120).max(4000),
});
export const placementEdit = geometry.extend({ version: z.number().int().nonnegative() });
export const edit = z.object({
  blockId: id,
  text: z.string().max(MAX_BLOCK_TEXT_CHARACTERS),
  version: z.number().int().nonnegative(),
});
export const submitRun = z.object({
  braneId: id,
  key: id,
  model: z.string().max(100),
  prompt: z.string().trim().min(1).max(20000),
  references: z.array(id).max(32),
  continueFrom: id.optional(),
  edits: z.array(edit).max(64).default([]),
  maxOutputTokens: z.number().int().positive().optional(),
});

export const spawnArtifact = z
  .object({
    braneId: id,
    key: id,
    sourceBlockIds: z
      .array(id)
      .min(1)
      .max(32)
      .refine((ids) => new Set(ids).size === ids.length, 'Duplicate source'),
    anchorPlacementId: id,
    action: z.literal('develop'),
    model: z.string().min(1).max(100),
    edits: z.array(edit).max(32).default([]),
  })
  .strict()
  .refine(
    (input) => input.edits.every((edit) => input.sourceBlockIds.includes(edit.blockId)),
    'Only source edits may be submitted',
  );

export const importIntent = z
  .object({
    key: id,
    braneId: id,
    geometry,
    target: z.enum(['canvas', 'composer']),
  })
  .strict();

export const pdfRepresentation = z.discriminatedUnion('status', [
  z
    .object({
      kind: z.literal('pdf-text-v1'),
      extractor: z.string(),
      status: z.literal('ready'),
      pages: z
        .array(z.object({ number: z.number().int().positive(), text: z.string().max(20000) }))
        .min(1)
        .max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal('pdf-text-v1'),
      extractor: z.string(),
      status: z.literal('unavailable'),
      reason: z.string(),
    })
    .strict(),
]);
export const content = z.discriminatedUnion('format', [
  z.object({ format: z.literal('text'), text: z.string() }).strict(),
  z
    .object({
      format: z.literal('webpage'),
      text: z.string(),
      url: z.string().optional(),
      status: z.enum(['pending', 'ready', 'failed']),
      error: z.string().optional(),
    })
    .strict(),
  z
    .object({
      format: z.literal('image'),
      text: z.string(),
      filename: z.string(),
      assetId: id,
      assetHash: z.string().regex(/^[a-f0-9]{64}$/),
      mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      frames: z.number().int().positive().optional(),
      representation: z.literal('original-image-v1'),
    })
    .strict(),
  z
    .object({
      format: z.literal('pdf'),
      text: z.string(),
      filename: z.string(),
      assetId: id,
      assetHash: z.string().regex(/^[a-f0-9]{64}$/),
      mimeType: z.literal('application/pdf'),
      pageCount: z.number().int().positive(),
      representation: pdfRepresentation,
    })
    .strict()
    .refine(
      (content) =>
        content.representation.status !== 'ready' ||
        (content.representation.pages.length === content.pageCount &&
          content.representation.pages.every((page, i) => page.number === i + 1)),
      'PDF pages must be complete and ordered',
    ),
]);
