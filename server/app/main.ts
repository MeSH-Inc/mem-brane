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
const app = new Hono();
app.get('/health', (c) => c.json({ status: 'ok', app: 'mem-brane' }));
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
      messages = await resolveMessages(db, storage, request.actor!, request.inputs);
    } catch {
      throw new BeforeInvocationError();
    }
    return executeModel({ ...request, messages }, onChunk);
  },
  {
    concurrency: config.WORKER_CONCURRENCY,
    leaseMs: config.LEASE_MS,
    checkpointMs: config.CHECKPOINT_INTERVAL_MS,
    checkpointCharacters: config.CHECKPOINT_CHARACTERS,
  },
);
const ingestion = new IngestionWorker(db, config.MAX_WEBPAGE_BYTES);
worker.start();
ingestion.start();
const server = serve({ fetch: app.fetch, port: config.PORT, hostname: '127.0.0.1' }, () =>
  console.log(`mem-brane API http://127.0.0.1:${config.PORT}`),
);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  await Promise.all([worker.stop(), ingestion.stop()]);
  db.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
