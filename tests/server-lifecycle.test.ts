import { it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/db';
it('runs real auth, uploads, SSE and worker shutdown against an isolated server', async () => {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const directory = mkdtempSync(join(tmpdir(), 'membrane-lifecycle-'));
  const origin = `http://127.0.0.1:${port}`;
  const database = join(directory, 'db.sqlite');
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/app/main.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      APP_ORIGIN: origin,
      DATABASE_PATH: database,
      ASSET_DIRECTORY: join(directory, 'assets'),
      MODEL_ALLOWLIST: 'mock',
      MODEL_DEFAULT: 'mock',
      MODEL_PRICING_JSON: '{}',
      R2_ENDPOINT: '',
      SHUTDOWN_MS: '2000',
      MAX_OUTPUT_TOKENS: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exit = once(child, 'exit');
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    await expect.poll(() => output, { timeout: 10000 }).toContain('mem-brane API');
    const signup = await fetch(`${origin}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({
        email: 'lifecycle@example.com',
        name: 'Lifecycle',
        password: 'test-lifecycle-password',
      }),
    });
    expect(signup.status).toBe(200);
    const cookie = signup.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const headers = { cookie, origin, 'content-type': 'application/json' };
    const brane = await (
      await fetch(`${origin}/api/branes`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: 'Lifecycle' }),
      })
    ).json();
    const form = new FormData();
    form.set(
      'intent',
      JSON.stringify({
        key: crypto.randomUUID(),
        braneId: brane.id,
        target: 'canvas',
        geometry: { x: 10, y: 20, width: 320, height: 300 },
      }),
    );
    form.set(
      'file',
      new Blob([
        await (
          await import('sharp')
        )
          .default({ create: { width: 2, height: 3, channels: 3, background: 'red' } })
          .png()
          .toBuffer(),
      ]),
      'test.png',
    );
    expect(
      (
        await fetch(`${origin}/api/imports`, {
          method: 'POST',
          headers: { cookie, origin },
          body: form,
        })
      ).status,
    ).toBe(201);
    const events = await fetch(`${origin}/api/events`, { headers: { cookie } });
    reader = events.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('ready');
    const run = await (
      await fetch(`${origin}/api/runs`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          braneId: brane.id,
          key: crypto.randomUUID(),
          model: 'mock',
          prompt: 'Long output '.repeat(100),
          references: [],
          edits: [],
        }),
      })
    ).json();
    await expect
      .poll(
        async () =>
          (await (await fetch(`${origin}/api/runs/${run.id}`, { headers: { cookie } })).json())
            .status,
      )
      .toBe('running');
    child.kill('SIGTERM');
    expect(await exit).toEqual([0, null]);
    const db = openDatabase(database);
    try {
      expect((db.prepare('SELECT status FROM runs WHERE id=?').get(run.id) as any).status).toBe(
        'interrupted',
      );
      expect((db.prepare('SELECT count(*) n FROM assets').get() as any).n).toBe(1);
    } finally {
      db.close();
    }
  } finally {
    await reader?.cancel().catch(() => {});
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exit;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);
