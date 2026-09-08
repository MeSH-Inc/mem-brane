import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
it('reports unavailable capacity and rejects admission without filling a disk', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'membrane-disk-http-'));
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((r) => listener.close(() => r()));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/app/main.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      READ_ONLY: '0',
      APP_ORIGIN: origin,
      PORT: String(port),
      DATABASE_PATH: join(directory, 'db.sqlite'),
      ASSET_DIRECTORY: join(directory, 'assets'),
      R2_ENDPOINT: '',
      MODEL_ALLOWLIST: 'mock',
      MODEL_DEFAULT: 'mock',
      MODEL_PRICING_JSON: '{}',
      MIN_FREE_DISK_BYTES: '9007199254740991',
      SHUTDOWN_MS: '2000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let ready = false;
  child.stdout.on('data', (b) => {
    if (String(b).includes('mem-brane API')) ready = true;
  });
  child.stderr.on('data', () => {});
  try {
    await expect.poll(() => ready, { timeout: 10000 }).toBe(true);
    expect((await fetch(origin + '/health')).status).toBe(503);
    const mutation = await fetch(origin + '/api/branes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(mutation.status).toBe(503);
    expect(mutation.headers.get('retry-after')).toBe('30');
    expect((await fetch(origin + '/api/branes')).status).toBe(401);
    expect(
      (
        await fetch(origin + '/api/runs/00000000-0000-4000-8000-000000000000/cancel', {
          method: 'POST',
        })
      ).status,
    ).toBe(401);
    child.kill('SIGTERM');
    expect(await exited).toEqual([0, null]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
