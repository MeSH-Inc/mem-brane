import { z } from 'zod';
import { content, pdfRepresentation, runStatus } from './schemas/index';
import type { BraneState, Content, Placement, Revision } from './types/domain';
import type { ConversationMessage } from './types/conversation';

// Response identities are opaque to readers; command schemas validate UUID input.
const identity = z.string().min(1);
export const braneResponse = z.object({
  id: identity,
  title: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});
export const placementResponse: z.ZodType<Placement> = z.object({
  id: identity,
  brane_id: identity,
  block_id: identity,
  version: z.number().int().nonnegative(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  z_index: z.number(),
});
export const contentResponse: z.ZodType<Content> = content;
export const pdfSummaryResponse = z.object({
  ...content.options[3].shape,
  representationId: identity,
  representation: z.union([
    z
      .object({ kind: z.literal('pdf-text-v1'), extractor: z.string(), status: z.literal('ready') })
      .strict(),
    pdfRepresentation.options[1],
  ]),
});
const workspaceContent = z.union([
  content.options[0],
  content.options[1],
  content.options[2],
  pdfSummaryResponse,
]);
export const runSummaryResponse = z
  .object({
    id: identity,
    brane_id: identity,
    status: runStatus,
    model: z.string(),
    provider: z.string(),
    output_block_id: identity,
    error: z.string().nullable(),
    usage_json: z.string().nullable(),
    retry_of: identity.nullable(),
    created_at: z.number(),
  })
  .strict();
export type RunSummary = z.infer<typeof runSummaryResponse>;
export const runResponse = runSummaryResponse.extend({ partial: z.string() });
export const workspaceResponse: z.ZodType<BraneState> = z.object({
  brane: braneResponse,
  blocks: z.array(
    z.object({
      id: identity,
      kind: z.enum(['text', 'image', 'webpage', 'pdf']),
      origin: z.enum(['authored', 'generated']),
      content: workspaceContent,
      version: z.number().int().nonnegative(),
      messageId: identity.optional(),
    }),
  ),
  placements: z.array(placementResponse),
  runs: z.array(runResponse),
  derivations: z.array(
    z.object({
      runId: identity,
      sourceBlockId: identity,
      sourceRevisionId: identity,
      outputBlockId: identity,
      position: z.number().int(),
      anchorPlacementId: identity.nullable(),
      outputPlacementId: identity.nullable(),
    }),
  ),
});
export const budgetResponse = z.object({
  day: z.string(),
  limitMicrousd: z.number(),
  committedMicrousd: z.number(),
  availableMicrousd: z.number(),
});
export type Budget = z.infer<typeof budgetResponse>;
export const configurationResponse = z.object({
  imports: z.object({ maxBytes: z.number().int().positive() }),
  models: z.array(z.string()),
  defaultModel: z.string(),
  maxOutputTokens: z.number().int().positive(),
  dailySpendEnforced: z.boolean(),
  modelCapabilities: z.record(z.string(), z.object({ vision: z.boolean(), pdfText: z.boolean() })),
  budget: budgetResponse,
});
export type Configuration = z.infer<typeof configurationResponse>;
export const modelPriceResponse = z.object({
  inputUsdPerMillion: z.number(),
  outputUsdPerMillion: z.number(),
  vision: z.boolean(),
  imageTokenBound: z.number(),
  source: z.string(),
  verifiedAt: z.string(),
});
export const estimateResponse = z.object({
  estimatedInputTokens: z.number(),
  reservedMicrousd: z.number(),
  canAfford: z.boolean(),
  budget: budgetResponse,
  price: modelPriceResponse,
});
export type Estimate = z.infer<typeof estimateResponse>;
export const savedTextResponse = z.object({
  version: z.number().int().nonnegative(),
  content: z.union([content.options[0], content.options[1]]),
});
export type SavedText = z.infer<typeof savedTextResponse>;
export const runInputResponse = z.object({
  position: z.number().int(),
  kind: z.enum(['source', 'reference', 'lineage_reference', 'lineage', 'prompt']),
  label: z.string(),
  role: z.enum(['user', 'assistant']),
  revision_id: identity,
  content: contentResponse,
});
export const runDetailResponse = runSummaryResponse.extend({
  started_at: z.number().nullable(),
  finished_at: z.number().nullable(),
  inputs: z.array(runInputResponse),
  output: z.object({ revision_id: identity, message_id: identity }).nullable(),
  cost: z
    .object({
      status: z.enum(['reserved', 'confirmed', 'uncertain', 'released']),
      reserved_microusd: z.number(),
      confirmed_microusd: z.number().nullable(),
    })
    .nullable(),
  checkpoint: z.object({ text: z.string(), updated_at: z.number() }).nullable(),
});
export type RunDetail = z.infer<typeof runDetailResponse>;
export const runPageResponse = z.object({
  items: z.array(runSummaryResponse),
  nextCursor: identity.nullable(),
});
export const revisionResponse: z.ZodType<Revision> = z.object({
  id: identity,
  block_id: identity,
  content: contentResponse,
  created_at: z.number(),
});
export const revisionPageResponse = z.object({
  items: z.array(
    z.object({
      id: identity,
      block_id: identity,
      created_at: z.number(),
      format: z.enum(['text', 'webpage', 'image', 'pdf']),
      preview: z.string(),
    }),
  ),
  nextCursor: identity.nullable(),
});
export const lineageResponse: z.ZodType<ConversationMessage[]> = z.array(
  z.object({
    id: identity,
    conversation_id: identity,
    parent_id: identity.nullable(),
    run_id: identity,
    role: z.enum(['user', 'assistant']),
    revision_id: identity,
    block_id: identity,
    created_at: z.number(),
    content: contentResponse,
    references: z.array(z.object({ label: z.string(), revision_id: identity })),
  }),
);
export const createdBlockResponse = z.object({ id: identity });
export const runIdentityResponse = z.object({ runId: identity, outputBlockId: identity });
export type RunIdentity = z.infer<typeof runIdentityResponse>;
export const importReceiptResponse = z.object({
  blockId: identity,
  placementId: identity,
  braneId: identity,
});
export const importStatusResponse = z.discriminatedUnion('state', [
  z.object({ state: z.literal('pending') }),
  z.object({ state: z.literal('ready'), result: importReceiptResponse }),
]);
export const sessionResponse = z
  .object({ user: z.object({ id: identity, name: z.string(), email: z.string() }) })
  .nullable();
export type Session = z.infer<typeof sessionResponse>;
export const runEventResponse = z.object({
  type: z.literal('run'),
  runId: identity,
  braneId: identity,
  status: runStatus.optional(),
  text: z.string().optional(),
});
export type RunEvent = z.infer<typeof runEventResponse>;
