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
const app = new Hono();
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
  const ready = !closing && worker.healthy && ingestion.healthy && disk.allowsWrites;
  return c.json({ status: ready ? 'ok' : 'unavailable', app: 'mem-brane' }, ready ? 200 : 503);
});
app.route('/api', createApi(db, auth, hub, storage));
app.get('/api/*', (c) => c.json({ error: 'Not found' }, 404));
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
}
const server = serve({ fetch: app.fetch, port: config.PORT, hostname: '127.0.0.1' }, () =>
  console.log(`mem-brane API http://127.0.0.1:${config.PORT}`),
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
    await Promise.all([drained, worker.stop(), ingestion.stop(), disk.stop()]);
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
