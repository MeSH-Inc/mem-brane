import type { DB } from '../db/index.js';
import type { RunInput } from '../../shared/types/domain.js';
import { lifecycleLog } from '../app/logging.js';
import { DomainError } from '../domain/access.js';
import { buildMessages } from '../llm/model.js';
export interface ModelPrice {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  vision: boolean;
  imageTokenBound: number;
  source: string;
  verifiedAt: string;
}
export interface CostPolicy {
  dailyLimitUsd: number;
  globalDailyLimitUsd?: number;
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
  return price;
}
export function estimatedInputTokens(inputs: RunInput[], price: ModelPrice) {
  // UTF-8 bytes overestimate text token counts for supported OpenAI byte-level tokenizers.
  // Include serialized reference wrappers and a generous per-message protocol allowance.
  return buildMessages(inputs).reduce(
    (n, message, i) =>
      n +
      Buffer.byteLength(JSON.stringify(message.content), 'utf8') +
      1024 +
      (inputs[i].content.assetId ? price.imageTokenBound : 0),
    1024,
  );
}
export function costMicro(input: number, output: number, price: ModelPrice) {
  return Math.ceil(input * price.inputUsdPerMillion + output * price.outputUsdPerMillion);
}
export function budgetState(db: DB, actor: string, policy?: CostPolicy, time = Date.now()) {
  const day = new Date(time).toISOString().slice(0, 10);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN status IN ('reserved','uncertain') THEN reserved_microusd WHEN status='confirmed' AND budget_day=? THEN confirmed_microusd ELSE 0 END),0) committed FROM run_costs WHERE owner_id=?`,
    )
    .get(day, actor) as { committed: number };
  const limit = Math.floor((policy?.dailyLimitUsd ?? 0) * 1e6);
  const global =
    policy?.globalDailyLimitUsd === undefined
      ? Infinity
      : Math.max(
          0,
          Math.floor(policy.globalDailyLimitUsd * 1e6) -
            (
              db
                .prepare(
                  `SELECT COALESCE(SUM(CASE WHEN status IN ('reserved','uncertain') THEN reserved_microusd WHEN status='confirmed' AND budget_day=? THEN confirmed_microusd ELSE 0 END),0) committed FROM run_costs`,
                )
                .get(day) as { committed: number }
            ).committed,
        );
  return {
    day,
    limitMicrousd: limit,
    committedMicrousd: row.committed,
    availableMicrousd: Math.min(global, Math.max(0, limit - row.committed)),
  };
}
export function reserveCost(
  db: DB,
  actor: string,
  runId: string,
  model: string,
  inputs: RunInput[],
  outputLimit: number,
  policy?: CostPolicy,
) {
  const price = priceFor(model, policy);
  if (inputs.some((i) => i.content.assetId) && !price.vision)
    throw new DomainError(400, 'This model does not support image context');
  const input = estimatedInputTokens(inputs, price),
    amount = costMicro(input, outputLimit, price),
    time = Date.now(),
    budget = budgetState(db, actor, policy, time);
  if (model !== 'mock' && policy?.globalDailyLimitUsd !== undefined) {
    const global = db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN status IN ('reserved','uncertain') THEN reserved_microusd WHEN status='confirmed' AND budget_day=? THEN confirmed_microusd ELSE 0 END),0) committed FROM run_costs`,
      )
      .get(budget.day) as { committed: number };
    if (
      global.committed + amount > Math.floor(policy.globalDailyLimitUsd * 1e6) ||
      policy.globalDailyLimitUsd <= 0
    )
      throw new DomainError(429, 'Operator model budget is fully committed');
  }
  if (amount > budget.availableMicrousd)
    throw new DomainError(
      429,
      'Daily model budget is fully committed, including uncertain previous calls',
    );
  db.prepare('INSERT INTO run_costs VALUES (?,?,?,?,?,?,NULL,?,?,?)').run(
    runId,
    actor,
    budget.day,
    'reserved',
    amount,
    input,
    JSON.stringify(price),
    time,
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
}
export function settleCost(
  db: DB,
  runId: string,
  usage?: { inputTokens?: number; outputTokens?: number },
  free = false,
) {
  const row = db.prepare('SELECT * FROM run_costs WHERE run_id=?').get(runId) as any;
  if (!row || row.status !== 'reserved') return;
  const confirmed = free
    ? 0
    : usage &&
        Number.isSafeInteger(usage.inputTokens) &&
        Number.isSafeInteger(usage.outputTokens) &&
        usage.inputTokens! >= 0 &&
        usage.outputTokens! >= 0
      ? costMicro(usage.inputTokens!, usage.outputTokens!, JSON.parse(row.pricing_json))
      : null;
  if (confirmed !== null && confirmed > row.reserved_microusd)
    lifecycleLog('budget_bound_exceeded', {
      runId,
      reservedMicrousd: row.reserved_microusd,
      confirmedMicrousd: confirmed,
    });
  db.prepare('UPDATE run_costs SET status=?,confirmed_microusd=?,updated_at=? WHERE run_id=?').run(
    confirmed === null ? 'uncertain' : 'confirmed',
    confirmed,
    Date.now(),
    runId,
  );
}
export function holdUncertainCost(db: DB, runId: string) {
  db.prepare(
    "UPDATE run_costs SET status='uncertain',updated_at=? WHERE run_id=? AND status='reserved'",
  ).run(Date.now(), runId);
}
export function releaseUninvokedCost(db: DB, runId: string) {
  db.prepare(
    "UPDATE run_costs SET status='released',updated_at=? WHERE run_id=? AND status='reserved' AND NOT EXISTS(SELECT 1 FROM run_attempts WHERE run_id=?)",
  ).run(Date.now(), runId, runId);
}

export function reconcileUncertainCost(
  db: DB,
  runId: string,
  confirmedMicrousd: number,
  evidence: string,
) {
  if (
    !Number.isSafeInteger(confirmedMicrousd) ||
    confirmedMicrousd < 0 ||
    evidence.trim().length < 8
  )
    throw new DomainError(
      400,
      'Provide a nonnegative integer micro-USD amount and provider evidence',
    );
  return db.transaction(() => {
    const result = db
      .prepare(
        "UPDATE run_costs SET status='confirmed',confirmed_microusd=?,updated_at=? WHERE run_id=? AND status='uncertain'",
      )
      .run(confirmedMicrousd, Date.now(), runId);
    if (!result.changes) throw new DomainError(409, 'Only uncertain billing can be reconciled');
    db.prepare('INSERT INTO run_cost_reconciliations VALUES (?,?,?,?)').run(
      runId,
      confirmedMicrousd,
      evidence.trim(),
      Date.now(),
    );
  })();
}

export function releaseFailedPreflightCost(db: DB, runId: string) {
  db.prepare(
    "UPDATE run_costs SET status='released',updated_at=? WHERE run_id=? AND status='reserved'",
  ).run(Date.now(), runId);
}
