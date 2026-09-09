import type { DB } from '../db/index.js';
import type { SubmitRun, RunInput } from '../../shared/types/domain.js';
import { canRunOnBrane, DomainError } from '../domain/access.js';
import { planBlockEdit, readSnapshotCandidate } from './content.js';
import { readLineage, lineageInputs, type ContextEntry } from './contexts.js';
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
  const edits = input.edits.map((edit) => ({
    blockId: edit.blockId,
    ...planBlockEdit(db, actor, edit),
  }));
  const drafts = new Map(edits.map((edit) => [edit.blockId, edit]));
  const lineage = input.continueFrom ? readLineage(db, actor, input.continueFrom) : [];
  const inputs: RunInput[] = lineageInputs(db, actor, lineage);
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
    const candidate = entry.blockId
      ? readSnapshotCandidate(db, actor, entry.blockId, drafts.get(entry.blockId))
      : undefined;
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
    conversationId: lineage.at(-1)?.conversation_id,
    quote: quoteCost(input.model, inputs, maxOutputTokens, limits.costPolicy),
  };
}
