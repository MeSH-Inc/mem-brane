import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

test('guest work, an interrupted import, composer and two tabs survive existing-account claiming and a lost response', async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  const directory = mkdtempSync(join(tmpdir(), 'membrane-guest-'));
  const origin = 'http://127.0.0.1:4197';
  const child = spawn(process.execPath, ['dist-server/main.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: '4197',
      APP_ORIGIN: origin,
      DATABASE_PATH: join(directory, 'db.sqlite'),
      ASSET_DIRECTORY: join(directory, 'assets'),
      MODEL_ALLOWLIST: 'mock',
      MODEL_DEFAULT: 'mock',
      MODEL_PRICING_JSON: '{}',
      R2_ENDPOINT: '',
      SHUTDOWN_MS: '3000',
      GUEST_MODE: 'enabled',
      SIGNUP_MODE: 'open',
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
    const accountContext = await context.browser()!.newContext();
    const credentials = {
      name: 'Keeper',
      email: 'guest-keeper@example.com',
      password: 'guest-browser-password',
    };
    expect(
      (
        await accountContext.request.post(`${origin}/api/auth/sign-up/email`, {
          data: credentials,
          headers: { origin },
        })
      ).ok(),
    ).toBeTruthy();
    const personal = await (
      await accountContext.request.post(`${origin}/api/branes`, {
        data: { title: 'Existing personal work' },
      })
    ).json();
    await accountContext.close();
    await page.goto(origin);
    await expect(page.getByLabel('Guest workspace')).toBeVisible();
    await expect(page).toHaveURL(/\/b\//);
    // Account prompts stay centered on phones instead of inheriting the
    // workspace sheet's left-aligned, bottom-docked margins.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const mobileAccount = page.getByRole('dialog', { name: 'Sign in' });
    const bounds = (await mobileAccount.boundingBox())!;
    expect(Math.abs(bounds.x + bounds.width / 2 - 195)).toBeLessThan(1);
    expect(Math.abs(bounds.y + bounds.height / 2 - 422)).toBeLessThan(1);
    await mobileAccount.getByRole('button', { name: 'Close sign in' }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    const braneId = new URL(page.url()).pathname.split('/')[2];
    const guest = await (await page.request.get(`${origin}/api/session`)).json();
    const oldCookies = await context.cookies();
    await page.getByRole('button', { name: 'Focus', exact: true }).click();
    await page.getByRole('button', { name: '＋ Add', exact: true }).click();
    await page.getByRole('button', { name: '＋ Text', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Block text', exact: true });
    await editor.fill('My guest thought');
    await expect(page.getByRole('status')).not.toContainText('Unsaved');
    // Account-only features invite sign-up before any request, never as an error.
    await page.getByRole('button', { name: 'Develop', exact: true }).click();
    const invite = page.getByRole('dialog', { name: 'Keep your workspace' });
    await expect(invite).toContainText('need a free account');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await invite.getByRole('button', { name: /close/i }).click();
    const second = await context.newPage();
    await second.goto(page.url());
    await expect(second.getByRole('textbox', { name: 'Block text', exact: true })).toHaveValue(
      'My guest thought',
    );
    let delayWrites = true;
    await context.route('**/api/sync/commands', async (route) => {
      if (delayWrites)
        await route.fulfill({ status: 503, json: { error: 'Temporary interruption' } });
      else await route.continue();
    });
    await editor.fill('My pending guest thought');
    const prompt = page.getByRole('textbox', { name: 'Run prompt' });
    await prompt.fill('Remember this composer');
    await expect(page.getByRole('status')).toContainText('Saved on device');
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#648863' } })
      .png()
      .toBuffer();
    await page.route(
      '**/api/imports',
      (route) => route.fulfill({ status: 503, json: { error: 'Interrupted upload' } }),
      { times: 1 },
    );
    await page
      .locator('input[type=file]')
      .setInputFiles({ name: 'guest.png', mimeType: 'image/png', buffer: png });
    await expect(page.getByRole('button', { name: 'Retry import' })).toBeVisible();
    // The authentication callback commits ownership; its response is lost.
    await page.route(
      '**/api/auth/sign-in/email',
      async (route) => {
        await route.fetch();
        await route.abort('failed');
      },
      { times: 1 },
    );
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Sign in' });
    await dialog.getByLabel('Email', { exact: true }).fill(credentials.email);
    await dialog.getByLabel('Password', { exact: true }).fill(credentials.password);
    await dialog.getByRole('button', { name: 'Open your space ↗' }).click();
    // Reload must finish the durable claim even though the form never received success.
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`${origin}/api/auth/get-session`)).json())?.user?.email,
      )
      .toBe(credentials.email);
    delayWrites = false;
    await page.reload();
    await expect(page.getByLabel('Guest workspace')).toHaveCount(0);
    await expect(editor).toHaveValue('My pending guest thought');
    await expect(prompt).toHaveValue('Remember this composer');
    await expect(page).toHaveURL(new RegExp(`/b/${braneId}`));
    const read = async () =>
      (
        await page.request.get(`${origin}/api/branes/${braneId}`, {
          headers: { 'X-Mem-Brane-Library': guest.libraryId },
        })
      ).json();
    await expect
      .poll(async () => (await read()).blocks.find((b: any) => b.kind === 'text')?.content.text)
      .toBe('My pending guest thought');
    await expect(second.getByLabel('Guest workspace')).toHaveCount(0);
    await expect(second.getByRole('textbox', { name: 'Block text', exact: true })).toHaveValue(
      'My pending guest thought',
    );
    const retry = page.getByRole('button', { name: 'Retry import' });
    if (await retry.isVisible()) await retry.click();
    await expect
      .poll(async () => (await read()).blocks.filter((b: any) => b.kind === 'image').length)
      .toBe(1);
    const state = await read();
    expect(state.blocks.filter((b: any) => b.kind === 'text')).toHaveLength(1);
    expect((await page.request.get(`${origin}/api/branes/${personal.id}`)).ok()).toBeTruthy();
    const retired = await context.browser()!.newContext();
    await retired.addCookies(oldCookies);
    expect((await retired.request.get(`${origin}/api/branes/${braneId}`)).status()).toBe(401);
    await retired.close();
    await page.screenshot({ path: 'artifacts/guest-entry.png', fullPage: true });
    await second.close();
  } finally {
    child.kill('SIGTERM');
    await exit;
    rmSync(directory, { recursive: true, force: true });
  }
});
