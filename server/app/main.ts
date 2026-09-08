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
const db = openDatabase(config.DATABASE_PATH),
  auth = createAuth(db),
  hub = new EventHub();
let closing = false;
let exitCode = 0;
const app = new Hono();
app.use('*', async (c, next) => {
  if (closing) return c.json({ error: 'Server is shutting down' }, 503);
  await next();
});
app.get('/health', (c) => {
  const ready = !closing && worker.healthy && ingestion.healthy;
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
    leaseMs: config.LEASE_MS,
    checkpointMs: config.CHECKPOINT_INTERVAL_MS,
    checkpointCharacters: config.CHECKPOINT_CHARACTERS,
  },
);
const ingestion = new IngestionWorker(db, config.MAX_WEBPAGE_BYTES, fatal);
worker.start();
ingestion.start();
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
    await Promise.all([drained, worker.stop(), ingestion.stop()]);
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
