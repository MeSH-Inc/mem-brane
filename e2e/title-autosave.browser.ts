import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('title autosave survives reload, serializes remote sync, and remains durable offline', async ({
  page,
  context,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'membrane-browser-'));
  const origin = 'http://127.0.0.1:4195';
  const database = join(directory, 'db.sqlite');
  const child = spawn(process.execPath, ['dist-server/main.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: '4195',
      APP_ORIGIN: origin,
      DATABASE_PATH: database,
      ASSET_DIRECTORY: join(directory, 'assets'),
      MODEL_ALLOWLIST: 'mock',
      MODEL_DEFAULT: 'mock',
      MODEL_PRICING_JSON: '{}',
      R2_ENDPOINT: '',
      SHUTDOWN_MS: '3000',
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
  try {
    await expect.poll(() => output).toContain('mem-brane API');
    const signup = await page.request.post(`${origin}/api/auth/sign-up/email`, {
      data: { name: 'Title tester', email: 'title@example.com', password: 'browser-test-password' },
      headers: { origin },
    });
    expect(signup.ok()).toBeTruthy();
    const brane = await (
      await page.request.post(`${origin}/api/branes`, { data: { title: 'Original title' } })
    ).json();
    const readTitle = async () =>
      (await (await page.request.get(`${origin}/api/branes/${brane.id}`)).json()).brane.title;
    await page.goto(`${origin}/b/${brane.id}?view=focus`);
    const title = page.getByRole('textbox', { name: 'Brane title' });
    await expect(title).toHaveValue('Original title');
    await expect(page.getByRole('button', { name: 'Save brane', exact: true })).toHaveCount(0);
    await title.fill('Recovered title');
    await page.reload();
    await expect(title).toHaveValue('Recovered title');
    await expect.poll(readTitle).toBe('Recovered title');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let saving = false;
    await context.route('**/api/sync/commands', async (route) => {
      if (route.request().postDataJSON().command.type === 'brane.title') {
        saving = true;
        await gate;
      }
      await route.continue();
    });
    await title.fill('Awaiting synchronization');
    await title.press('Tab');
    await expect.poll(() => saving).toBe(true);
    await title.fill('Newer title');
    await title.press('Tab');
    release();
    await expect.poll(readTitle).toBe('Newer title');
    await page.reload();
    await expect(title).toHaveValue('Newer title');
    // The installed shell and replica preserve the title without a server connection.
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await context.setOffline(true);
    await title.fill('Offline title');
    await title.press('Tab');
    await expect(page.locator('.save-notice')).toHaveText('Saved on device · Syncing…');
    await page.reload();
    await expect(title).toHaveValue('Offline title');
    await context.setOffline(false);
    await expect.poll(readTitle).toBe('Offline title');
  } finally {
    await context.setOffline(false).catch(() => {});
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exit;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
