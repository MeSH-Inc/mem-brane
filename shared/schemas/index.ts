import { z } from 'zod';
export const id = z.string().uuid();
export const geometry = z.object({
  x: z.number().finite().min(-1e6).max(1e6),
  y: z.number().finite().min(-1e6).max(1e6),
  width: z.number().min(180).max(4000),
  height: z.number().min(120).max(4000),
});
export const edit = z.object({
  blockId: id,
  text: z.string().max(100000),
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
