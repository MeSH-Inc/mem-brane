import { z } from 'zod';
import { runStatus } from '../../shared/schemas/index.js';

// Persistence records are distinct from public DTOs. Full-row decoders also catch
// schema drift and invalid stored JSON before it reaches services or the worker.
const identity = { id: z.string(), owner_id: z.string(), created_at: z.number().int() };
export const braneRecord = z
  .object({ ...identity, title: z.string(), updated_at: z.number().int() })
  .strict();
export const blockRecord = z
  .object({
    ...identity,
    kind: z.enum(['text', 'image', 'webpage', 'pdf']),
    origin: z.enum(['authored', 'generated']),
  })
  .strict();
export const assetRecord = z
  .object({
    ...identity,
    storage_key: z.string(),
    mime: z.string(),
    size: z.number().int().positive(),
    digest: z.string(),
  })
  .strict();
export const conversationRecord = z.object(identity).strict();
export const runRecord = z
  .object({
    ...identity,
    brane_id: z.string(),
    submission_key: z.string(),
    request_hash: z.string(),
    status: runStatus,
    provider: z.string(),
    model: z.string(),
    options_json: z.string(),
    output_block_id: z.string(),
    conversation_id: z.string(),
    context_id: z.string(),
    retry_of: z.string().nullable(),
    lease_owner: z.string().nullable(),
    lease_until: z.number().int().nullable(),
    usage_json: z.string().nullable(),
    estimated_usage_json: z.string().nullable(),
    error: z.string().nullable(),
    started_at: z.number().int().nullable(),
    finished_at: z.number().int().nullable(),
  })
  .strict();
export const runOptions = z
  .object({
    maxOutputTokens: z.number().int().positive(),
    action: z.literal('develop').optional(),
    actionVersion: z.literal(1).optional(),
  })
  .strict();
export type RunRecord = z.infer<typeof runRecord>;
export type BlockRecord = z.infer<typeof blockRecord>;
export type BraneRecord = z.infer<typeof braneRecord>;
export type AssetRecord = z.infer<typeof assetRecord>;
export const ownedRecords = {
  branes: braneRecord,
  blocks: blockRecord,
  runs: runRecord,
  assets: assetRecord,
  conversations: conversationRecord,
};
export type OwnedRecords = { [K in keyof typeof ownedRecords]: z.infer<(typeof ownedRecords)[K]> };
export function decodeRecord<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error('Invalid database record', { cause: result.error });
  return result.data;
}
export function decodeJson<T>(schema: z.ZodType<T>, json: string): T {
  return decodeRecord(schema, JSON.parse(json) as unknown);
}
