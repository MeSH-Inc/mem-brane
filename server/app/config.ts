import { modelPrice } from '../domain/money.js';
import 'dotenv/config';
import { z } from 'zod';
const positive = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const env = z
  .object({
    PORT: positive(3001),
    READ_ONLY: z.enum(['0', '1']).default('0'),
    APP_ORIGIN: z.string().url().default('http://localhost:5173'),
    DATABASE_PATH: z.string().default('data/mem-brane.sqlite'),
    ASSET_DIRECTORY: z.string().default('data/assets'),
    MIN_FREE_DISK_BYTES: positive(1073741824),
    DISK_CHECK_INTERVAL_MS: positive(15000),
    COMPLETED_CHECKPOINT_RETENTION_DAYS: positive(7),
    TELEMETRY_INTERVAL_MS: positive(10000),
    WORKER_CONCURRENCY: positive(2),
    USER_RUN_LIMIT: positive(3),
    MAX_OUTPUT_TOKENS: positive(1024),
    MAX_CONTEXT_CHARACTERS: positive(100000),
    MAX_WEBPAGE_BYTES: positive(1048576),
    MAX_UPLOAD_BYTES: positive(5242880),
    USER_STORAGE_BYTES: positive(104857600),
    TOTAL_STORAGE_BYTES: positive(1073741824),
    USER_IMPORT_LIMIT: positive(3),
    IMPORT_QUEUE_LIMIT: positive(6),
    RUN_QUEUE_LIMIT: positive(8),
    GLOBAL_MONTHLY_SPEND_LIMIT: z.coerce.number().nonnegative().default(0),
    MODEL_DAILY_SPEND_LIMIT: z.coerce.number().nonnegative().optional(),
    MODEL_MONTHLY_SPEND_LIMIT: z.coerce.number().nonnegative().optional(),
    OCR_DAILY_SPEND_LIMIT: z.coerce.number().nonnegative().default(10),
    OCR_MONTHLY_SPEND_LIMIT: z.coerce.number().nonnegative().default(100),
    OCR_PROVIDER: z.enum(['disabled', 'mistral']).default('disabled'),
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

export const costPolicy = {
  dailyLimitUsd: config.DAILY_USER_SPEND_LIMIT,
  globalDailyLimitUsd: config.GLOBAL_DAILY_SPEND_LIMIT,
  globalMonthlyLimitUsd: config.GLOBAL_MONTHLY_SPEND_LIMIT,
  categoryDailyLimitUsd: config.MODEL_DAILY_SPEND_LIMIT,
  categoryMonthlyLimitUsd: config.MODEL_MONTHLY_SPEND_LIMIT,
  prices: z
    .record(z.string(), modelPrice)
    .parse(JSON.parse(process.env.MODEL_PRICING_JSON || '{}')),
};
