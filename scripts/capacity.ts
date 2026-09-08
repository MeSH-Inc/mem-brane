import { MAX_BRANE_PLACEMENTS, MAX_BLOCK_TEXT_CHARACTERS } from '../shared/limits.js';
// Isolated fixture exercise: no live database, provider or object storage is used.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, totalmem, availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { openDatabase } from '../server/db/index.js';
import { createAuth } from '../server/auth/index.js';
import { createBrane, createBlock, revisions, uid } from '../server/services/content.js';
import { submitRun } from '../server/services/runs.js';
const output = process.argv[2];
if (!output)
  throw new Error(
    'Usage: node --import tsx scripts/capacity.ts /report.json [queue-size] [text-characters] [max-output-tokens]',
  );
const queueLimit = Number(process.argv[3] ?? 8),
  chars = Number(process.argv[4] ?? 2048);
if (
  !Number.isInteger(queueLimit) ||
  queueLimit < 1 ||
  queueLimit > 100 ||
  !Number.isInteger(chars) ||
  chars < 1 ||
  chars > MAX_BLOCK_TEXT_CHARACTERS
)
  throw new Error('Fixture exceeds supported exercise bounds');
const directory = mkdtempSync(join(tmpdir(), 'membrane-capacity-'));
const path = join(directory, 'fixture.sqlite');
const db = openDatabase(path);
const listener = createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = (listener.address() as { port: number }).port;
await new Promise<void>((r) => listener.close(() => r()));
const origin = `http://127.0.0.1:${port}`;
const auth = createAuth(db);
const signed = await auth.api.signUpEmail({
  body: {
    name: 'Capacity fixture',
    email: `${uid()}@example.com`,
    password: 'capacity-fixture-password',
  },
  asResponse: true,
});
const actor = (await signed.json()).user.id;
const cookie = signed.headers
  .getSetCookie()
  .map((s) => s.split(';')[0])
  .join('; ');
const brane = createBrane(db, actor);
db.transaction(() => {
  for (let i = 0; i < MAX_BRANE_PLACEMENTS; i++)
    createBlock(db, actor, 'text', { format: 'text', text: 'x'.repeat(chars) }, brane.id);
})();
let overflowRejected = false;
try {
  createBlock(db, actor, 'text', { format: 'text', text: '' }, brane.id);
} catch {
  overflowRejected = true;
}
const maxTokens = Number(process.argv[5] ?? 128);
if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 1024)
  throw new Error('Fixture token limit must be 1..1024');
const limits = {
  models: ['mock'],
  maxTokens,
  userConcurrency: 3,
  maxContextCharacters: 100000,
  queueLimit,
};
for (let i = 0; i < queueLimit; i++) {
  if (i % 3 === 0) {
    const owner = uid();
    db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
      owner,
      'Load',
      `${owner}@example.com`,
      0,
      0,
    );
    const space = createBrane(db, owner);
    for (let j = 0; j < Math.min(3, queueLimit - i); j++)
      submitRun(
        db,
        revisions(db),
        owner,
        {
          braneId: space.id,
          key: uid(),
          model: 'mock',
          prompt: process.argv[5]
            ? 'Capacity exercise '.repeat(Math.ceil(limits.maxTokens / 4))
            : 'Capacity exercise',
          references: [],
          edits: [],
        },
        limits,
      );
  }
}
const child = spawn(process.execPath, ['dist-server/main.js'], {
  env: {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(port),
    APP_ORIGIN: origin,
    DATABASE_PATH: path,
    ASSET_DIRECTORY: join(directory, 'assets'),
    R2_ENDPOINT: '',
    MODEL_ALLOWLIST: 'mock',
    MODEL_DEFAULT: 'mock',
    MODEL_PRICING_JSON: '{}',
    WORKER_CONCURRENCY: '2',
    MAX_OUTPUT_TOKENS: String(limits.maxTokens),
    TELEMETRY_INTERVAL_MS: '250',
    RUN_QUEUE_LIMIT: String(queueLimit),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = once(child, 'exit');
let started = false,
  buffer = '';
const samples: Record<string, number>[] = [];
child.stdout.on('data', (chunk) => {
  buffer += String(chunk);
  const lines = buffer.split('\n');
  buffer = lines.pop()!;
  for (const line of lines) {
    if (line.includes('mem-brane API')) started = true;
    try {
      const event = JSON.parse(line);
      if (event.event === 'runtime_sample') samples.push(event);
    } catch {}
  }
});
child.stderr.on('data', () => {});
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const deadline = Date.now() + 180000;
const latency: number[] = [],
  bytes: number[] = [],
  status: Record<string, number> = {};
try {
  while (!started) {
    if (Date.now() > deadline || child.exitCode !== null)
      throw new Error('Fixture server failed to start');
    await pause(50);
  }
  // Four parallel readers, 40 full workspace responses, while two workers drain a full queue.
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let i = 0; i < 10; i++) {
        const start = performance.now();
        const response = await fetch(`${origin}/api/branes/${brane.id}`, {
          headers: { cookie },
          signal: AbortSignal.timeout(30000),
        });
        const body = await response.arrayBuffer();
        latency.push(performance.now() - start);
        bytes.push(body.byteLength);
        status[response.status] = (status[response.status] ?? 0) + 1;
      }
    }),
  );
  while (
    (
      db
        .prepare("SELECT count(*) n FROM runs WHERE status IN ('queued','claimed','running')")
        .get() as { n: number }
    ).n
  ) {
    if (Date.now() > deadline) throw new Error('Queue did not drain within 180 seconds');
    await pause(250);
  }
  const percentile = (values: number[], p: number) =>
    [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] ?? 0;
  const waits = (
    db.prepare('SELECT started_at-created_at wait FROM runs').all() as { wait: number }[]
  ).map((r) => r.wait);
  const durations = (
    db.prepare('SELECT finished_at-started_at duration FROM runs').all() as { duration: number }[]
  ).map((r) => r.duration);
  const outcomes = db.prepare('SELECT status,count(*) count FROM runs GROUP BY status').all() as {
    status: string;
    count: number;
  }[];
  const report = {
    time: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      totalMemoryGiB: totalmem() / 2 ** 30,
      cpus: availableParallelism(),
    },
    fixture: {
      placements: MAX_BRANE_PLACEMENTS,
      textCharacters: chars,
      queueLimit,
      workerConcurrency: 2,
      maxOutputTokens: limits.maxTokens,
      readConcurrency: 4,
      requests: 40,
      overflowRejected,
    },
    http: {
      status,
      p50Ms: percentile(latency, 0.5),
      p95Ms: percentile(latency, 0.95),
      maxMs: Math.max(...latency),
      responseBytes: Math.max(...bytes),
    },
    runtime: {
      samples: samples.length,
      peakSampledRssBytes: Math.max(...samples.map((s) => s.rssBytes)),
      maxEventLoopMs: Math.max(...samples.map((s) => s.eventLoopMaxMs)),
    },
    workers: {
      outcomes,
      queueWaitP95Ms: percentile(waits, 0.95),
      queueWaitMaxMs: Math.max(...waits),
      durationP95Ms: percentile(durations, 0.95),
    },
  };
  writeFileSync(resolve(output), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (status['200'] !== 40 || !overflowRejected || outcomes.some((r) => r.status !== 'completed'))
    throw new Error('Capacity exercise failed');
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await exited;
  }
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
