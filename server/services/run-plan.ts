import type { DB } from '../db/index.js';
import type { SubmitRun, RunInput } from '../../shared/types/domain.js';
import { canRunOnBrane, DomainError } from '../domain/access.js';
import { type ContextEntry } from './contexts.js';
import { contextReader } from './context-reader.js';
import { quoteCost, type CostPolicy } from './costs.js';

export interface RunPlanLimits {
  models: string[];
  maxTokens: number;
  maxContextCharacters: number;
  costPolicy?: CostPolicy;
}
// Unsnapshotted entries will receive UUIDs at commit; this preserves their wire byte bound.
const pendingRevision = '00000000-0000-0000-0000-000000000000';
export function planRun(
  db: DB,
  actor: string,
  input: SubmitRun,
  limits: RunPlanLimits,
  sources: string[] = [],
) {
  canRunOnBrane(db, actor, input.braneId);
  if (!limits.models.includes(input.model)) throw new DomainError(400, 'Model is not allowed');
  const maxOutputTokens = Math.min(input.maxOutputTokens ?? limits.maxTokens, limits.maxTokens);
  if (new Set(input.edits.map((edit) => edit.blockId)).size !== input.edits.length)
    throw new DomainError(400, 'Only one edit per block may be submitted');
  const context = contextReader(db, actor).plan(
    [...sources, ...input.references],
    input.edits,
    input.continueFrom,
  );
  const inputs: RunInput[] = context.inputs;
  const entries: { blockId?: string; kind: ContextEntry['kind']; label: string }[] = [
    ...sources.map((blockId, index) => ({
      blockId,
      kind: 'source' as const,
      label: index === 0 ? 'Primary source' : `Source ${index + 1}`,
    })),
    ...input.references.map((blockId, index) => ({
      blockId,
      kind: 'reference' as const,
      label: `Reference ${index + 1}`,
    })),
    { kind: 'prompt', label: 'Prompt' },
  ];
  for (const entry of entries) {
    const candidate = entry.blockId ? context.candidates.get(entry.blockId)! : undefined;
    inputs.push({
      position: inputs.length,
      kind: entry.kind,
      label: entry.label,
      role: 'user',
      revision_id: candidate?.revision?.id ?? pendingRevision,
      content: candidate?.content ?? { format: 'text', text: input.prompt },
    });
  }
  if (
    inputs.reduce((sum, item) => sum + JSON.stringify(item.content).length, 0) >
    limits.maxContextCharacters
  )
    throw new DomainError(400, 'Context is too large');
  return {
    maxOutputTokens,
    entries,
    conversationId: context.conversationId,
    quote: quoteCost(input.model, inputs, maxOutputTokens, limits.costPolicy),
  };
}
