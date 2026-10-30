import type { DB } from '../db/index.js';
import type { SubmitRun, RunInput } from '../../shared/types/domain.js';
import { canRunOnBrane, DomainError } from '../domain/access.js';
import { type ContextEntry } from './contexts.js';
import { contextReader } from './context-reader.js';
import { quoteCost, type CostPolicy } from './costs.js';
import { relationText } from '../../shared/relations.js';

export interface RunPlanLimits {
  models: string[];
  maxTokens: number;
  maxContextCharacters: number;
  costPolicy?: CostPolicy;
}
// Unsnapshotted entries will receive UUIDs at commit; this preserves their wire byte bound.
const pendingRevision = '00000000-0000-0000-0000-000000000000';
// A machine run labels each reference with the slot it fills and freezes the machine's
// own revision as the prompt, so the receipt shows which template produced the output.
export interface MachinePlan {
  blockId: string;
  slots: string[];
}
export interface PlannedEntry {
  blockId?: string;
  kind: ContextEntry['kind'];
  label: string;
  // A relation entry names two earlier entries by position.
  relation?: { label: string; from: number; to: number };
}
// How a relation names its ends: by entry label, with the frozen revision when two
// entries share a label (several cards fill one machine slot).
export function relationEntryText(
  entries: PlannedEntry[],
  revisions: string[],
  relation: NonNullable<PlannedEntry['relation']>,
) {
  const name = (index: number) =>
    entries.filter((entry) => entry.label === entries[index].label).length > 1
      ? `${entries[index].label} (revision ${revisions[index]})`
      : entries[index].label;
  return relationText(relation.label, name(relation.from), name(relation.to));
}
// The brane's arrows whose two ends are both inputs of this run, in drawing order.
function relationEntries(db: DB, braneId: string, entries: PlannedEntry[]): PlannedEntry[] {
  const rows = db
    .prepare<unknown[], { label: string; from_block: string; to_block: string }>(
      `SELECT r.label,f.block_id from_block,t.block_id to_block FROM relations r
       JOIN placements f ON f.id=r.from_placement_id JOIN placements t ON t.id=r.to_placement_id
       WHERE r.brane_id=? ORDER BY r.rowid`,
    )
    .all(braneId);
  const position = (blockId: string) =>
    entries.findIndex((entry) => entry.kind !== 'prompt' && entry.blockId === blockId);
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    const from = position(row.from_block),
      to = position(row.to_block);
    const key = `${from}:${to}:${row.label}`;
    if (from < 0 || to < 0 || from === to || seen.has(key)) return [];
    seen.add(key);
    return [
      { kind: 'relation' as const, label: 'Relation', relation: { label: row.label, from, to } },
    ];
  });
}
export function planRun(
  db: DB,
  actor: string,
  input: SubmitRun,
  limits: RunPlanLimits,
  sources: string[] = [],
  machine?: MachinePlan,
) {
  canRunOnBrane(db, actor, input.braneId);
  if (!limits.models.includes(input.model)) throw new DomainError(400, 'Model is not allowed');
  const maxOutputTokens = Math.min(input.maxOutputTokens ?? limits.maxTokens, limits.maxTokens);
  if (new Set(input.edits.map((edit) => edit.blockId)).size !== input.edits.length)
    throw new DomainError(400, 'Only one edit per block may be submitted');
  const context = contextReader(db, actor).plan(
    [...sources, ...input.references, ...(machine ? [machine.blockId] : [])],
    input.edits,
    input.continueFrom,
  );
  const inputs: RunInput[] = context.inputs;
  const inputEntries: PlannedEntry[] = [
    ...sources.map((blockId, index) => ({
      blockId,
      kind: 'source' as const,
      label: index === 0 ? 'Primary source' : `Source ${index + 1}`,
    })),
    ...input.references.map((blockId, index) => ({
      blockId,
      kind: 'reference' as const,
      label: machine?.slots[index] ?? `Reference ${index + 1}`,
    })),
  ];
  const entries: PlannedEntry[] = [
    ...inputEntries,
    ...relationEntries(db, input.braneId, inputEntries),
    { blockId: machine?.blockId, kind: 'prompt', label: 'Prompt' },
  ];
  const pending = entries.map(() => pendingRevision);
  for (const entry of entries) {
    const candidate = entry.blockId ? context.candidates.get(entry.blockId)! : undefined;
    inputs.push({
      position: inputs.length,
      kind: entry.kind,
      label: entry.label,
      role: 'user',
      revision_id: candidate?.revision?.id ?? pendingRevision,
      content: entry.relation
        ? { format: 'text', text: relationEntryText(entries, pending, entry.relation) }
        : (candidate?.content ?? { format: 'text', text: input.prompt }),
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
