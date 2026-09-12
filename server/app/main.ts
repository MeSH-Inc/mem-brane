import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DiskMonitor } from './disk.js';
import { Maintenance } from './maintenance.js';
import { Telemetry } from './telemetry.js';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { config } from './config.js';
import { openDatabase } from '../db/index.js';
import { createAuth } from '../auth/index.js';
import { createApi } from '../api/index.js';
import { EventHub } from '../sse/hub.js';
import { RunWorker } from '../jobs/worker.js';
import { OcrWorker } from '../jobs/ocr-worker.js';
import { OcrService, defaultOcrLimits } from '../services/ocr.js';
import { createMistralOcrProvider } from '../ingestion/mistral-ocr.js';
import { IngestionWorker } from '../ingestion/webpage.js';
import { executeModel } from '../llm/model.js';
import { BeforeInvocationError } from '../llm/errors.js';
import { resolveMessages } from '../llm/assets.js';
import { assetStore } from '../storage/assets.js';
const storage = assetStore();
const diskPaths = [dirname(config.DATABASE_PATH)];
if (!process.env.R2_ENDPOINT) diskPaths.push(config.ASSET_DIRECTORY);
for (const path of diskPaths) mkdirSync(path, { recursive: true });
const disk = new DiskMonitor(diskPaths, config.MIN_FREE_DISK_BYTES, config.DISK_CHECK_INTERVAL_MS);
await disk.start();
const db = openDatabase(config.DATABASE_PATH),
  auth = createAuth(db),
  hub = new EventHub();
let closing = false;
let exitCode = 0;
const ocr = new OcrService(
  db,
  storage,
  config.OCR_PROVIDER === 'mistral'
    ? createMistralOcrProvider({ apiKey: process.env.MISTRAL_API_KEY ?? '' })
    : undefined,
  {
    ...defaultOcrLimits,
    maxUploadBytes: config.MAX_UPLOAD_BYTES,
    globalDailyLimitUsd: config.GLOBAL_DAILY_SPEND_LIMIT,
    globalMonthlyLimitUsd: config.GLOBAL_MONTHLY_SPEND_LIMIT,
    categoryDailyLimitUsd: config.OCR_DAILY_SPEND_LIMIT,
    categoryMonthlyLimitUsd: config.OCR_MONTHLY_SPEND_LIMIT,
  },
);
const app = new Hono();
const redirectHosts = new Set(
  config.REDIRECT_HOSTS.split(',')
    .map((host) => host.trim())
    .filter(Boolean),
);
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  if (redirectHosts.has(url.hostname)) {
    const canonical = new URL(config.APP_ORIGIN);
    canonical.pathname = url.pathname;
    canonical.search = url.search;
    return c.redirect(canonical.toString(), 308);
  }
  await next();
});
app.use('*', async (c, next) => {
  if (config.READ_ONLY === '1' && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method))
    return c.json({ error: 'Server is in read-only recovery mode' }, 503);
  if (
    !disk.allowsWrites &&
    !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
    !/^\/api\/runs\/[^/]+\/cancel$/.test(c.req.path) &&
    c.req.path !== '/api/auth/sign-out'
  ) {
    c.header('Retry-After', '30');
    return c.json({ error: 'Storage is temporarily unavailable; edits remain local' }, 503);
  }
  if (closing) return c.json({ error: 'Server is shutting down' }, 503);
  await next();
});
app.get('/health', (c) => {
  const ready =
    !closing && worker.healthy && ingestion.healthy && ocrWorker.healthy && disk.allowsWrites;
  return c.json({ status: ready ? 'ok' : 'unavailable', app: 'mem-brane' }, ready ? 200 : 503);
});
app.route('/api', createApi(db, auth, hub, storage, ocr));
app.get('/api/*', (c) => c.json({ error: 'Not found' }, 404));
app.use('/*', async (c, next) => {
  c.header(
    'Cache-Control',
    c.req.path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  );
  await next();
});
app.use('/*', serveStatic({ root: './dist' }));
app.get('*', serveStatic({ path: './dist/index.html' }));
const worker = new RunWorker(
  db,
  hub,
  async (request, onChunk) => {
    let messages;
    try {
      messages = await resolveMessages(db, storage, request.actor!, request.inputs, request.signal);
    } catch {
      throw new BeforeInvocationError();
    }
    request.signal.throwIfAborted();
    return executeModel({ ...request, messages }, onChunk);
  },
  {
    concurrency: config.WORKER_CONCURRENCY,
    totalMs: config.RUN_TOTAL_MS,
    idleMs: config.RUN_IDLE_MS,
    onFatal: fatal,
    canClaim: () => disk.allowsWrites && config.READ_ONLY !== '1',
    leaseMs: config.LEASE_MS,
    checkpointMs: config.CHECKPOINT_INTERVAL_MS,
    checkpointCharacters: config.CHECKPOINT_CHARACTERS,
  },
);
const ingestion = new IngestionWorker(
  db,
  config.MAX_WEBPAGE_BYTES,
  fatal,
  () => disk.allowsWrites && config.READ_ONLY !== '1',
);
const ocrWorker = new OcrWorker(ocr, () => disk.allowsWrites && config.READ_ONLY !== '1', fatal);
const telemetry = new Telemetry(db, config.TELEMETRY_INTERVAL_MS, fatal);
telemetry.start();
const maintenance = new Maintenance(
  db,
  { completedCheckpointDays: config.COMPLETED_CHECKPOINT_RETENTION_DAYS, batchSize: 100 },
  fatal,
);
if (config.READ_ONLY !== '1') maintenance.start();
if (config.READ_ONLY !== '1') {
  worker.start();
  ingestion.start();
  ocrWorker.start();
}
const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, () =>
  console.log(`mem-brane API http://${config.HOST}:${config.PORT}`),
);
function fatal() {
  exitCode = 1;
  queueMicrotask(() => void shutdown());
}
async function shutdown() {
  if (closing) return;
  closing = true;
  telemetry.stop();
  maintenance.stop();
  const deadline = setTimeout(() => process.exit(1), config.SHUTDOWN_MS);
  hub.close();
  // Streams can become idle after close() has swept existing keep-alive sockets.
  const idleSockets = setInterval(() => {
    (server as import('node:http').Server).closeIdleConnections();
  }, 50);
  try {
    const drained = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await Promise.all([drained, worker.stop(), ingestion.stop(), ocrWorker.stop(), disk.stop()]);
    db.close();
  } catch {
    exitCode = 1;
  } finally {
    clearTimeout(deadline);
    clearInterval(idleSockets);
    process.exit(exitCode);
  }
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
