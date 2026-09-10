import {
  committedSpend,
  spendAvailable,
  reserveSpend,
  reconcileSpend,
  type SpendLimits,
} from './spend.js';
import {
  modelPrice,
  money,
  tokens,
  usdLimit,
  pricedCost,
  type ModelPrice,
  type Microusd,
} from '../domain/money.js';
import { decodeRecord, readRunCost } from '../db/records.js';
import type { Budget } from '../../shared/contracts.js';
import { modelCompatibility } from '../../shared/representations.js';
import type { DB } from '../db/index.js';
import type { RunInput } from '../../shared/types/domain.js';
import { lifecycleLog } from '../app/logging.js';
import { DomainError } from '../domain/access.js';
import { buildMessages } from '../llm/model.js';
export type { ModelPrice } from '../domain/money.js';
export interface CostPolicy extends SpendLimits {
  dailyLimitUsd: number;
  categoryDailyLimitUsd?: number;
  categoryMonthlyLimitUsd?: number;
  prices: Record<string, ModelPrice>;
}
export const freePrice: ModelPrice = {
  inputUsdPerMillion: 0,
  outputUsdPerMillion: 0,
  vision: false,
  imageTokenBound: 0,
  source: 'local mock',
  verifiedAt: '2026-09-08',
};
export function priceFor(model: string, policy?: CostPolicy): ModelPrice {
  if (model === 'mock') return { ...freePrice, vision: true };
  const price = policy?.prices[model];
  if (!price || !policy || policy.dailyLimitUsd <= 0)
    throw new DomainError(
      403,
      'Paid runs require verified model pricing and a positive daily budget',
    );
  usdLimit(policy.dailyLimitUsd);
  return decodeRecord(modelPrice, price);
}
export function estimatedInputTokens(inputs: RunInput[], price: ModelPrice) {
  // UTF-8 bytes overestimate text token counts for supported OpenAI byte-level tokenizers.
  // Include serialized reference wrappers and a generous per-message protocol allowance.
  return tokens(
    buildMessages(inputs).reduce(
      (n, message, i) =>
        n +
        Buffer.byteLength(JSON.stringify(message.content), 'utf8') +
        1024 +
        (inputs[i].content.format === 'image' ? price.imageTokenBound : 0),
      1024,
    ),
  );
}
export function costMicro(input: number, output: number, price: ModelPrice) {
  return pricedCost(tokens(input), tokens(output), decodeRecord(modelPrice, price));
}
export function budgetState(db: DB, actor: string, policy?: CostPolicy, time = Date.now()): Budget {
  const day = new Date(time).toISOString().slice(0, 10);
  const committed = committedSpend(db, day, { actor, category: 'model' });
  const limit = usdLimit(policy?.dailyLimitUsd ?? 0);
  const global = spendAvailable(db, actor, 'model', policy ?? {}, time);
  return {
    day,
    limitMicrousd: limit,
    committedMicrousd: committed,
    availableMicrousd: Math.min(global, Math.max(0, limit - committed)),
  };
}
export function quoteCost(
  model: string,
  inputs: RunInput[],
  outputLimit: number,
  policy?: CostPolicy,
) {
  const price = priceFor(model, policy);
  for (const input of inputs) {
    const incompatible = modelCompatibility(input.content, price.vision);
    if (incompatible) throw new DomainError(400, incompatible);
  }
  const inputTokens = estimatedInputTokens(inputs, price);
  return {
    model,
    price,
    outputLimit,
    inputTokens,
    amount: costMicro(inputTokens, outputLimit, price),
  };
}
export type CostQuote = ReturnType<typeof quoteCost>;
export function canAffordQuote(quote: CostQuote, budget: Budget, policy?: CostPolicy): boolean {
  return (
    quote.amount <= budget.availableMicrousd &&
    (quote.model === 'mock' ||
      (usdLimit(policy?.globalDailyLimitUsd ?? 0) > 0 &&
        usdLimit(policy?.globalMonthlyLimitUsd ?? 0) > 0))
  );
}
export function reserveCost(
  db: DB,
  actor: string,
  runId: string,
  quote: CostQuote,
  policy?: CostPolicy,
) {
  return db
    .transaction(() => {
      const { price, inputTokens: input, amount, outputLimit } = quote;
      const time = Date.now(),
        budget = budgetState(db, actor, policy, time);
      if (!canAffordQuote(quote, budget, policy))
        throw new DomainError(
          429,
          'Daily model budget is fully committed, including uncertain previous calls',
        );
      reserveSpend(
        db,
        { id: runId, actor, category: 'model', amount, units: input, pricing: price },
        { ...policy, userDailyLimitUsd: policy?.dailyLimitUsd ?? 0 },
        time,
      );
      db.prepare('UPDATE runs SET estimated_usage_json=? WHERE id=?').run(
        JSON.stringify({
          inputTokens: input,
          maxOutputTokens: outputLimit,
          reservedMicrousd: amount,
          method: 'conservative byte bound',
        }),
        runId,
      );
    })
    .immediate();
}
export function settleCost(
  db: DB,
  runId: string,
  usage?: { inputTokens?: number; outputTokens?: number },
) {
  const row = readRunCost(db, runId);
  if (row.status !== 'reserved') return;
  let confirmed: Microusd | null = null;
  if (row.price.inputUsdPerMillion === 0 && row.price.outputUsdPerMillion === 0)
    confirmed = money(0);
  else if (usage) {
    try {
      confirmed = costMicro(usage.inputTokens!, usage.outputTokens!, row.price);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
  }
  if (confirmed !== null && confirmed > row.reserved_microusd)
    lifecycleLog('budget_bound_exceeded', {
      runId,
      reservedMicrousd: row.reserved_microusd,
      confirmedMicrousd: confirmed,
    });
  db.prepare(
    'UPDATE spend_commitments SET status=?,confirmed_microusd=?,updated_at=? WHERE run_id=?',
  ).run(confirmed === null ? 'uncertain' : 'confirmed', confirmed, Date.now(), runId);
}
export function holdUncertainCost(db: DB, runId: string) {
  readRunCost(db, runId);
  db.prepare(
    "UPDATE spend_commitments SET status='uncertain',updated_at=? WHERE run_id=? AND status='reserved'",
  ).run(Date.now(), runId);
}
export function releaseUninvokedCost(db: DB, runId: string) {
  readRunCost(db, runId);
  db.prepare(
    "UPDATE spend_commitments SET status='released',updated_at=? WHERE run_id=? AND status='reserved' AND NOT EXISTS(SELECT 1 FROM run_attempts WHERE run_id=?)",
  ).run(Date.now(), runId, runId);
}

export function reconcileUncertainCost(
  db: DB,
  runId: string,
  confirmedMicrousd: number,
  evidence: string,
) {
  readRunCost(db, runId);
  return reconcileSpend(db, runId, confirmedMicrousd, evidence);
}

export function releaseFailedPreflightCost(db: DB, runId: string) {
  readRunCost(db, runId);
  db.prepare(
    "UPDATE spend_commitments SET status='released',updated_at=? WHERE run_id=? AND status='reserved'",
  ).run(Date.now(), runId);
}
