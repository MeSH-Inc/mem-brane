import 'dotenv/config';
import { z } from 'zod';
const positive = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const env = z
  .object({
    PORT: positive(3001),
    APP_ORIGIN: z.string().url().default('http://localhost:5173'),
    DATABASE_PATH: z.string().default('data/mem-brane.sqlite'),
    ASSET_DIRECTORY: z.string().default('data/assets'),
    WORKER_CONCURRENCY: positive(2),
    USER_RUN_LIMIT: positive(3),
    MAX_OUTPUT_TOKENS: positive(1024),
    MAX_CONTEXT_CHARACTERS: positive(100000),
    MAX_WEBPAGE_BYTES: positive(1048576),
    MAX_UPLOAD_BYTES: positive(5242880),
    USER_STORAGE_BYTES: positive(104857600),
    TOTAL_STORAGE_BYTES: positive(1073741824),
    USER_IMPORT_LIMIT: positive(10),
    IMPORT_QUEUE_LIMIT: positive(100),
    RUN_QUEUE_LIMIT: positive(100),
    GLOBAL_DAILY_SPEND_LIMIT: z.coerce.number().nonnegative().default(0),
    CHECKPOINT_INTERVAL_MS: positive(1000),
    CHECKPOINT_CHARACTERS: positive(256),
    LEASE_MS: positive(30000),
    RUN_TOTAL_MS: positive(300000),
    RUN_IDLE_MS: positive(60000),
    SHUTDOWN_MS: positive(20000),
    DAILY_USER_SPEND_LIMIT: z.coerce.number().nonnegative().default(0),
  })
  .parse(process.env);
export const config = {
  ...env,
  models: (process.env.MODEL_ALLOWLIST || 'mock').split(',').map((s) => s.trim()),
  defaultModel: process.env.MODEL_DEFAULT || 'mock',
};
if (!config.models.includes(config.defaultModel))
  throw new Error('MODEL_DEFAULT must be allowlisted');

const priceSchema = z
  .object({
    inputUsdPerMillion: z.number().nonnegative(),
    outputUsdPerMillion: z.number().nonnegative(),
    vision: z.boolean(),
    imageTokenBound: z.number().int().nonnegative(),
    source: z.string().url(),
    verifiedAt: z.iso.date(),
  })
  .refine(
    (p) => !p.vision || p.imageTokenBound > 0,
    'Vision models require a conservative image token bound',
  );
export const costPolicy = {
  dailyLimitUsd: config.DAILY_USER_SPEND_LIMIT,
  globalDailyLimitUsd: config.GLOBAL_DAILY_SPEND_LIMIT,
  prices: z
    .record(z.string(), priceSchema)
    .parse(JSON.parse(process.env.MODEL_PRICING_JSON || '{}')),
};
