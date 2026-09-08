import Database from 'better-sqlite3';
// Rehearse a downloaded bundle without modifying the original bundle or live data.
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { verifyBundle } from '../server/storage/bundle.js';
import { openDatabase } from '../server/db/index.js';
import { createAuth } from '../server/auth/index.js';
import { uid } from '../server/services/content.js';
const source = process.argv[2];
if (!source)
  throw new Error(
    'Usage: node --import tsx scripts/rehearse-restore.ts /downloaded/backup-directory',
  );
const started = performance.now();
const checked = await verifyBundle(source);
const directory = await mkdtemp(join(tmpdir(), 'membrane-rehearsal-'));
try {
  await cp(source, join(directory, 'restore'), { recursive: true });
  const path = join(directory, 'restore', 'db.sqlite');
  const db = openDatabase(path);
  const runStates = JSON.stringify(db.prepare('SELECT id,status FROM runs ORDER BY id').all());
  let cookie: string, assetId: string | undefined, braneId: string;
  try {
    // Sessions are minted only in the disposable restored copy.
    let user = db.prepare('SELECT id FROM "user" ORDER BY createdAt LIMIT 1').get() as
      { id: string } | undefined;
    const auth = createAuth(db);
    if (!user) {
      const signed = await auth.api.signUpEmail({
        body: {
          name: 'Rehearsal',
          email: `${uid()}@example.com`,
          password: 'rehearsal-fixture-password',
        },
      });
      user = { id: signed.user.id };
    }
    // Better Auth signs cookies; use its internal session creation and signing helper through a fresh fixture login.
    const signed = await auth.api.signUpEmail({
      body: {
        name: 'Rehearsal probe',
        email: `${uid()}@example.com`,
        password: 'rehearsal-probe-password',
      },
      asResponse: true,
    });
    const probe = (await signed.json()).user.id;
    cookie = signed.headers
      .getSetCookie()
      .map((s) => s.split(';')[0])
      .join('; ');
    // Place a copied artifact into a probe-owned workspace by testing existing owner's API via session owner mapping.
    db.prepare('UPDATE session SET userId=? WHERE userId=?').run(user.id, probe);
    const brane = db.prepare('SELECT id FROM branes WHERE owner_id=? LIMIT 1').get(user.id) as
      { id: string } | undefined;
    braneId = brane?.id ?? '';
    assetId = (
      db.prepare('SELECT id FROM assets WHERE owner_id=? LIMIT 1').get(user.id) as
        { id: string } | undefined
    )?.id;
  } finally {
    db.close();
  }
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((r) => listener.close(() => r()));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['dist-server/main.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      READ_ONLY: '1',
      OPENAI_API_KEY: '',
      PORT: String(port),
      APP_ORIGIN: origin,
      DATABASE_PATH: path,
      ASSET_DIRECTORY: join(directory, 'restore', 'assets'),
      R2_ENDPOINT: '',
      MODEL_ALLOWLIST: 'mock',
      MODEL_DEFAULT: 'mock',
      MODEL_PRICING_JSON: '{}',
      SHUTDOWN_MS: '3000',
      MIN_FREE_DISK_BYTES: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exit = once(child, 'exit');
  let ready = false;
  child.stdout.on('data', (b) => {
    if (String(b).includes('mem-brane API')) ready = true;
  });
  child.stderr.on('data', () => {});
  try {
    const deadline = Date.now() + 10000;
    while (!ready) {
      if (Date.now() > deadline || child.exitCode !== null)
        throw new Error('Restored server failed to start');
      await new Promise((r) => setTimeout(r, 50));
    }
    const routes = [
      '/health',
      '/api/branes',
      ...(braneId ? [`/api/branes/${braneId}`] : []),
      ...(assetId ? [`/api/assets/${assetId}`] : []),
    ];
    for (const route of routes) {
      const response = await fetch(origin + route, {
        headers: { cookie },
        signal: AbortSignal.timeout(5000),
      });
      await response.arrayBuffer();
      if (!response.ok) throw new Error(`Restored route failed: ${route} (${response.status})`);
    }
    const observed = new Database(path, { readonly: true });
    try {
      if (
        JSON.stringify(observed.prepare('SELECT id,status FROM runs ORDER BY id').all()) !==
        runStates
      )
        throw new Error('Historical execution changed during read-only rehearsal');
    } finally {
      observed.close();
    }
    console.log(
      JSON.stringify({
        verified: checked,
        httpRoutes: routes.length,
        historicalRunsUnchanged: true,
        elapsedMs: Math.round(performance.now() - started),
        source: 'supplied bundle; host separation must be established by transfer evidence',
      }),
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exit;
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
