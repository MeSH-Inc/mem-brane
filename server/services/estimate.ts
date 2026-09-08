import { modelCompatibility } from '../../shared/representations.js';
import type { DB } from '../db/index.js';
import type { SubmitRun, RunInput } from '../../shared/types/domain.js';
import { canRunOnBrane, requireOwned, DomainError } from '../domain/access.js';
import { readLineage, lineageInputs } from './contexts.js';
import {
  budgetState,
  costMicro,
  estimatedInputTokens,
  priceFor,
  type CostPolicy,
} from './costs.js';
export function estimateRun(
  db: DB,
  actor: string,
  input: SubmitRun,
  outputLimit: number,
  policy: CostPolicy,
) {
  canRunOnBrane(db, actor, input.braneId);
  const inputs: RunInput[] = [];
  const add = (
    content: RunInput['content'],
    kind: RunInput['kind'],
    label: string,
    role: RunInput['role'] = 'user',
    revision_id = '00000000-0000-0000-0000-000000000000',
  ) => inputs.push({ position: inputs.length, kind, label, role, revision_id, content });
  if (input.continueFrom)
    inputs.push(...lineageInputs(db, readLineage(db, actor, input.continueFrom)));
  for (const [i, blockId] of input.references.entries()) {
    requireOwned(db, 'blocks', actor, blockId);
    const row = (db
      .prepare('SELECT content_json FROM block_live_state WHERE block_id=?')
      .get(blockId) ??
      db
        .prepare(
          'SELECT content_json FROM block_revisions WHERE block_id=? ORDER BY created_at DESC LIMIT 1',
        )
        .get(blockId)) as any;
    if (!row) continue;
    const content = JSON.parse(row.content_json),
      edit = input.edits.find((e) => e.blockId === blockId);
    if (edit) content.text = edit.text;
    add(content, 'reference', `Reference ${i + 1}`);
  }
  add({ format: 'text', text: input.prompt }, 'prompt', 'Prompt');
  const price = priceFor(input.model, policy),
    tokens = estimatedInputTokens(inputs, price),
    reservedMicrousd = costMicro(
      tokens,
      Math.min(input.maxOutputTokens ?? outputLimit, outputLimit),
      price,
    ),
    budget = budgetState(db, actor, policy);
  for (const input of inputs) {
    const incompatible = modelCompatibility(input.content, price.vision);
    if (incompatible) throw new DomainError(400, incompatible);
  }
  return {
    estimatedInputTokens: tokens,
    reservedMicrousd,
    canAfford: reservedMicrousd <= budget.availableMicrousd,
    budget,
    price,
  };
}
