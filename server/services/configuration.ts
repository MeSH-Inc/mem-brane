import type { Configuration } from '../../shared/contracts.js';
import type { DB } from '../db/index.js';
import { config, costPolicy } from '../app/config.js';
import { budgetState } from './costs.js';

export function readConfiguration(db: DB, actor: string): Configuration {
  return {
    imports: { maxBytes: config.MAX_UPLOAD_BYTES },
    models: config.models,
    defaultModel: config.defaultModel,
    maxOutputTokens: config.MAX_OUTPUT_TOKENS,
    dailySpendEnforced: true,
    modelCapabilities: Object.fromEntries(
      config.models.map((model) => [
        model,
        {
          vision: model === 'mock' || costPolicy.prices[model]?.vision === true,
          pdfText: true,
        },
      ]),
    ),
    budget: budgetState(db, actor, costPolicy),
  };
}
