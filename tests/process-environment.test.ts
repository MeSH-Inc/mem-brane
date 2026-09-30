import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { testProcessEnvironment } from './fixtures/process-environment';

const deployment = {
  NODE_ENV: 'production',
  HOST: '0.0.0.0',
  SIGNUP_MODE: 'closed',
  GUEST_MODE: 'disabled',
  BETTER_AUTH_SECRET: 'sentinel-deployment-secret-with-32-characters',
  SIGNUP_INVITE_CODE: 'sentinel-invite-code-with-32-characters',
  DATABASE_PATH: '/sentinel/live.sqlite',
  ASSET_DIRECTORY: '/sentinel/assets',
  WORKER_CONCURRENCY: '13',
  MODEL_ALLOWLIST: 'paid-sentinel',
  MODEL_DEFAULT: 'paid-sentinel',
  OPENAI_API_KEY: 'sentinel-openai-key',
  OCR_PROVIDER: 'mistral',
  MISTRAL_API_KEY: 'sentinel-mistral-key',
  R2_ENDPOINT: 'https://sentinel.invalid',
  R2_BUCKET: 'sentinel-assets',
  R2_ACCESS_KEY_ID: 'sentinel-assets-key',
  R2_SECRET_ACCESS_KEY: 'sentinel-assets-secret',
  BACKUP_ENDPOINT: 'https://sentinel.invalid',
  BACKUP_BUCKET: 'sentinel-backups',
  BACKUP_ACCESS_KEY_ID: 'sentinel-backup-key',
  BACKUP_SECRET_ACCESS_KEY: 'sentinel-backup-secret',
  BACKUP_PREFIX: 'sentinel-production',
  RESEND_API_KEY: 'sentinel-resend-key',
  MAIL_FROM: 'sentinel@example.com',
  BACKUP_ALERT_EMAIL: 'sentinel-operator@example.com',
  HTTP_PROXY: 'https://sentinel.invalid',
  NODE_OPTIONS: '--require=/sentinel/preload.cjs',
  DOTENV_CONFIG_PATH: '/sentinel/.env',
  FUTURE_PROVIDER_SECRET: 'sentinel-future-secret',
};
const tsxLoader = createRequire(import.meta.url).resolve('tsx');

it('allowlists runtime settings and accepts only deliberate fixture overrides', () => {
  const env = testProcessEnvironment(
    { DATABASE_PATH: '/fixture/db.sqlite', SHUTDOWN_MS: '1000' },
    { ...deployment, PATH: '/runtime/bin', TMPDIR: '/runtime/tmp', HOME: '/sentinel/home' },
  );
  expect(env).toEqual({
    PATH: '/runtime/bin',
    TMPDIR: '/runtime/tmp',
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    SIGNUP_MODE: 'open',
    GUEST_MODE: 'enabled',
    BETTER_AUTH_SECRET: 'isolated-fixture-only-mem-brane-auth-secret',
    MODEL_ALLOWLIST: 'mock',
    MODEL_DEFAULT: 'mock',
    MODEL_PRICING_JSON: '{}',
    OCR_PROVIDER: 'disabled',
    SHUTDOWN_MS: '1000',
    DATABASE_PATH: '/fixture/db.sqlite',
  });
});

it('ignores deployment settings in both the parent environment and a local .env unless explicitly loaded', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'membrane-env-'));
  const execute = promisify(execFile);
  const configUrl = new URL('../server/app/config.ts', import.meta.url).href;
  const mailUrl = new URL('../server/services/mail.ts', import.meta.url).href;
  const assetsUrl = new URL('../server/storage/assets.ts', import.meta.url).href;
  try {
    // These are fake credentials. Merely inspect configuration; never start
    // workers or dispatch provider requests, even if isolation regresses.
    await writeFile(
      join(directory, '.env'),
      Object.entries(deployment)
        .filter(([key]) => !['NODE_OPTIONS', 'DOTENV_CONFIG_PATH'].includes(key))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
    );
    const env = testProcessEnvironment(
      {
        DATABASE_PATH: join(directory, 'fixture.sqlite'),
        ASSET_DIRECTORY: join(directory, 'assets'),
      },
      { ...process.env, ...deployment },
    );
    const { stdout } = await execute(
      process.execPath,
      [
        '--import',
        tsxLoader,
        '--input-type=module',
        '--eval',
        `const { config } = await import(${JSON.stringify(configUrl)});
         const { mailSettings } = await import(${JSON.stringify(mailUrl)});
         const { assetStore, FileAssetStore } = await import(${JSON.stringify(assetsUrl)});
         console.log(JSON.stringify({
           model: config.defaultModel,
           ocr: config.OCR_PROVIDER,
           workers: config.WORKER_CONCURRENCY,
           database: config.DATABASE_PATH,
           localAssets: assetStore() instanceof FileAssetStore,
           mail: Boolean(mailSettings()),
           inheritedKeys: ${JSON.stringify(Object.keys(deployment))}.filter(
             key => process.env[key] === ${JSON.stringify(deployment)}[key]
           )
         }));`,
      ],
      { cwd: directory, env },
    );
    expect(JSON.parse(stdout)).toEqual({
      model: 'mock',
      ocr: 'disabled',
      workers: 2,
      database: join(directory, 'fixture.sqlite'),
      localAssets: true,
      mail: false,
      inheritedKeys: [],
    });

    // Application commands opt into .env at their entry point. Importing the
    // configuration module itself must remain free of environment side effects.
    const explicit = await execute(
      process.execPath,
      [
        '--env-file=.env',
        '--import',
        tsxLoader,
        '--input-type=module',
        '--eval',
        `const { config } = await import(${JSON.stringify(configUrl)});
         console.log(JSON.stringify({ workers: config.WORKER_CONCURRENCY }));`,
      ],
      { cwd: directory, env },
    );
    expect(JSON.parse(explicit.stdout)).toEqual({ workers: 13 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
