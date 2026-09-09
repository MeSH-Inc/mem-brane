import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('interrupted two-tab edits remain recoverable and stale Spawn requires explicit conflict resolution', async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'membrane-browser-'));
  const origin = 'http://127.0.0.1:4189';
  const database = join(directory, 'db.sqlite');
  const child = spawn(process.execPath, ['dist-server/main.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: '4189',
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
      data: { name: 'Browser', email: 'browser@example.com', password: 'browser-test-password' },
      headers: { origin },
    });
    expect(signup.ok()).toBeTruthy();
    const brane = await (
      await page.request.post(`${origin}/api/branes`, { data: { title: 'Browser' } })
    ).json();
    const block = await (
      await page.request.post(`${origin}/api/blocks/text`, { data: { braneId: brane.id } })
    ).json();
    await page.goto(`${origin}/b/${brane.id}?view=focus`);
    await expect(page.getByRole('textbox', { name: 'Block text', exact: true })).toBeVisible();
    const text = (p: typeof page) => p.getByRole('textbox', { name: 'Block text', exact: true });
    const other = await page.context().newPage();
    await other.goto(`${origin}/b/${brane.id}?view=focus`);
    // Both edits are interrupted before reaching the server.
    for (const p of [page, other])
      await p.route('**/api/blocks/live', (route) => route.abort('internetdisconnected'));
    await text(page).fill('Tab A: take the north route');
    await text(other).fill('Tab B: take the south route');
    for (const p of [page, other])
      await expect(p.getByRole('alert')).toContainText('Failed to fetch');
    for (const p of [page, other]) {
      await p.reload();
      await p.getByText('Other saved drafts', { exact: true }).click();
      await expect(p.getByRole('region', { name: 'Saved draft' })).toHaveCount(2);
      await expect(text(p)).toHaveValue('');
    }
    const saved = (p: typeof page, value: string) =>
      p
        .getByRole('region', { name: 'Saved draft' })
        .filter({ has: p.getByText(value, { exact: true }) });
    await saved(page, 'Tab A: take the north route')
      .getByRole('button', { name: 'Recover a copy' })
      .click();
    await page.unroute('**/api/blocks/live');
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`${origin}/api/branes/${brane.id}`)).json()).blocks[0]
            .content.text,
      )
      .toBe('Tab A: take the north route');
    // The second tab is stale; Spawn must reject its original version and show the conflict.
    await saved(other, 'Tab B: take the south route')
      .getByRole('button', { name: 'Recover a copy' })
      .click();
    await other.getByRole('button', { name: 'Spawn', exact: true }).click();
    await expect(other.getByText('This block changed elsewhere', { exact: true })).toBeVisible();
    await other.getByText('Compare original, my draft and server text', { exact: true }).click();
    const comparison = other
      .locator('.draft-recovery')
      .filter({ has: other.getByText('This block changed elsewhere', { exact: true }) });
    await expect(comparison.locator('pre')).toHaveText([
      '',
      'Tab B: take the south route',
      'Tab A: take the north route',
    ]);
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`${origin}/api/branes/${brane.id}`)).json()).runs.length,
      )
      .toBe(0);
    await other.unroute('**/api/blocks/live');
    await other.getByRole('button', { name: 'Overwrite with my draft', exact: true }).click();
    await expect(text(other)).toHaveValue('Tab B: take the south route');
    await expect(other.getByText('This block changed elsewhere', { exact: true })).toHaveCount(0);
    await other.getByRole('button', { name: 'Spawn', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`${origin}/api/branes/${brane.id}`)).json()).runs[0]
            ?.status,
      )
      .toBe('completed');
    await page.reload();
    await page.getByText('Other saved drafts', { exact: true }).click();
    await expect(saved(page, 'Tab A: take the north route')).toHaveCount(1);
    await expect(saved(page, 'Tab B: take the south route')).toHaveCount(1);
    await other.close();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exit;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
