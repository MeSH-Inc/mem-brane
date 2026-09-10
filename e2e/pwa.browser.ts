import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('installed shell reloads offline, retains edits and creation, and reconciles a remote conflict', async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  const directory = mkdtempSync(join(tmpdir(), 'membrane-pwa-'));
  const origin = 'http://127.0.0.1:4193';
  const child = spawn(process.execPath, ['dist-server/main.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: '4193',
      APP_ORIGIN: origin,
      DATABASE_PATH: join(directory, 'db.sqlite'),
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
  child.stdout.on('data', (value) => {
    output += value;
  });
  child.stderr.on('data', (value) => {
    output += value;
  });
  try {
    await expect.poll(() => output).toContain('mem-brane API');
    const signup = await page.request.post(`${origin}/api/auth/sign-up/email`, {
      data: { name: 'Offline', email: 'offline@example.com', password: 'offline-test-password' },
      headers: { origin },
    });
    expect(signup.ok()).toBeTruthy();
    const brane = await (
      await page.request.post(`${origin}/api/branes`, { data: { title: 'Offline workspace' } })
    ).json();
    const block = await (
      await page.request.post(`${origin}/api/blocks/text`, { data: { braneId: brane.id } })
    ).json();
    await page.goto(`${origin}/b/${brane.id}?view=focus`);
    const editor = page.getByRole('textbox', { name: 'Block text', exact: true });
    await expect(editor).toBeVisible();
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    const manifest = await (await page.request.get(`${origin}/manifest.webmanifest`)).json();
    expect(manifest.display).toBe('standalone');
    await context.setOffline(true);
    await editor.fill('My offline thought');
    await expect(page.getByRole('status')).toHaveText(
      'Saved on this device · synchronization pending',
    );
    await page.reload();
    await expect(editor).toHaveValue('My offline thought');
    await expect(page.getByLabel('App connection and updates')).toContainText('Disconnected');
    // APIRequestContext can still simulate an independent remote writer while the browser is offline.
    const remote = await page.request.patch(`${origin}/api/blocks/live`, {
      data: { blockId: block.id, text: 'Another device edited this', version: 0 },
    });
    expect(remote.ok()).toBeTruthy();
    await context.setOffline(false);
    await expect(
      page.getByText('Synchronization paused for this item:', { exact: false }),
    ).toBeVisible();
    await expect(editor).toHaveValue('My offline thought');
    await page.getByRole('button', { name: 'Review conflict', exact: true }).click();
    await expect(page.locator('.conflict-comparison')).toContainText('Another device edited this');
    await page.getByRole('button', { name: 'Keep local changes', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`${origin}/api/branes/${brane.id}`)).json()).blocks[0]
            .content.text,
      )
      .toBe('My offline thought');
    await context.setOffline(true);
    await page.getByRole('button', { name: /New brane/ }).click();
    await expect(page.getByRole('textbox', { name: 'Brane title' })).toHaveValue('Untitled brane');
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Brane title' })).toHaveValue('Untitled brane');
    await page.getByRole('button', { name: 'Focus', exact: true }).click();
    await page.getByRole('button', { name: '＋ Text', exact: true }).click();
    await page.getByRole('textbox', { name: 'Block text', exact: true }).fill('Created offline');
    await expect(page.getByRole('status')).toHaveText(
      'Saved on this device · synchronization pending',
    );
    await page.getByRole('button', { name: 'Block actions', exact: true }).click();
    await page.getByText('Placements in this brane (1)', { exact: true }).click();
    await page.getByRole('spinbutton', { name: 'x', exact: true }).fill('850');
    await page.getByRole('button', { name: 'Apply geometry', exact: true }).click();
    await expect(page.getByText('Placement geometry saved', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Block text', exact: true })).toHaveValue(
      'Created offline',
    );
    // Lazy Canvas code was cached at installation, even when only Focus was opened online.
    await page.getByRole('button', { name: 'Canvas', exact: true }).click();
    await expect(page.locator('.react-flow')).toBeVisible();
    await context.setOffline(false);
    await expect
      .poll(async () => (await (await page.request.get(`${origin}/api/branes`)).json()).length)
      .toBe(2);
    // The service worker's cache contains no authenticated API responses.
    expect(
      await page.evaluate(async () => {
        const keys = await caches.keys();
        const urls = await Promise.all(
          keys.map(async (key) =>
            (await (await caches.open(key)).keys()).map((r) => new URL(r.url).pathname),
          ),
        );
        return urls.flat().some((path) => path.startsWith('/api/'));
      }),
    ).toBe(false);
  } finally {
    await context.setOffline(false).catch(() => {});
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exit;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
