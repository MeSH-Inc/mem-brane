import type { Estimate } from '../../shared/contracts.js';
import type { DB } from '../db/index.js';
import type { SubmitRun } from '../../shared/types/domain.js';
import { budgetState, canAffordQuote } from './costs.js';
import { planRun, type MachinePlan, type RunPlanLimits } from './run-plan.js';

export function estimateRun(
  db: DB,
  actor: string,
  input: SubmitRun,
  limits: RunPlanLimits,
  machine?: MachinePlan,
): Estimate {
  return db.transaction(() => {
    const { quote } = planRun(db, actor, input, limits, [], machine);
    const budget = budgetState(db, actor, limits.costPolicy);
    return {
      runs: 1,
      estimatedInputTokens: quote.inputTokens,
      reservedMicrousd: quote.amount,
      canAfford: canAffordQuote(quote, budget, limits.costPolicy),
      budget,
      price: quote.price,
    };
  })();
}
