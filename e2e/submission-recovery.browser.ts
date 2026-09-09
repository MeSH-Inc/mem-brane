import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('uncertain compose and Spawn retry their original requests after reload without duplicate runs', async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'membrane-browser-'));
  const origin = 'http://127.0.0.1:4191';
  const database = join(directory, 'db.sqlite');
  const child = spawn(process.execPath, ['dist-server/main.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: '4191',
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
    const prompt = page.getByRole('textbox', { name: 'Run prompt' });
    const read = async () =>
      await (await page.request.get(`${origin}/api/branes/${brane.id}`)).json();
    const requests: any[] = [];
    await page.route(
      '**/api/runs',
      async (route) => {
        requests.push(route.request().postDataJSON());
        const result = await route.fetch();
        expect(result.ok()).toBe(true);
        await route.abort('connectionreset');
      },
      { times: 1 },
    );
    await prompt.fill('Original request');
    await page.getByRole('button', { name: 'Run ↗', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Retry submission ↗', exact: true }),
    ).toBeEnabled();
    await prompt.fill('New intent must survive reconciliation');
    await page.reload();
    await expect(prompt).toHaveValue('New intent must survive reconciliation');
    await page.route(
      '**/api/runs',
      async (route) => {
        requests.push(route.request().postDataJSON());
        await route.continue();
      },
      { times: 1 },
    );
    await page.getByRole('button', { name: 'Retry submission ↗', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Run ↗', exact: true })).toBeEnabled();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    await expect(prompt).toHaveValue('New intent must survive reconciliation');
    await expect.poll(async () => (await read()).runs.length).toBe(1);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Run ↗', exact: true })).toBeEnabled();

    // A timeout response after server acceptance is also uncertain for Spawn.
    const spawns: any[] = [];
    await page.route(
      '**/api/artifacts/spawn',
      async (route) => {
        spawns.push(route.request().postDataJSON());
        const result = await route.fetch();
        expect(result.ok()).toBe(true);
        await route.fulfill({ status: 408, json: { error: 'Response timed out' } });
      },
      { times: 1 },
    );
    await page.route('**/api/blocks/live', (route) => route.abort('internetdisconnected'));
    await page
      .getByRole('textbox', { name: 'Block text', exact: true })
      .fill('Source that must spawn once');
    await page.getByRole('button', { name: 'Spawn', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry Spawn', exact: true })).toBeEnabled();
    expect(spawns[0].edits).toHaveLength(1);
    await page
      .getByRole('textbox', { name: 'Block text', exact: true })
      .fill('New local source edit');
    await expect(page.getByRole('alert')).toContainText(
      /Failed to fetch|Resolve the changed block/,
    );
    await page.reload();
    await page.getByText(/^Other saved drafts \(/).click();
    await page
      .getByRole('region', { name: 'Saved draft' })
      .filter({ has: page.getByText('New local source edit', { exact: true }) })
      .getByRole('button', { name: 'Recover a copy' })
      .click();
    const source = (await read()).blocks.find((b: any) => b.id === block.id);
    expect(
      (
        await page.request.patch(`${origin}/api/blocks/live`, {
          data: { blockId: block.id, version: source.version, text: 'Concurrent server edit' },
        })
      ).ok(),
    ).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event('brane:reconcile')));
    await expect(page.getByText('This block changed elsewhere', { exact: true })).toBeVisible();
    await page.route(
      '**/api/artifacts/spawn',
      async (route) => {
        spawns.push(route.request().postDataJSON());
        await route.continue();
      },
      { times: 1 },
    );
    await page.getByRole('button', { name: 'Retry Spawn', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Spawn', exact: true })).toBeEnabled();
    expect(spawns).toHaveLength(2);
    expect(spawns[1]).toEqual(spawns[0]);
    await expect(page.getByText('This block changed elsewhere', { exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Block text', exact: true })).toHaveValue(
      'New local source edit',
    );
    expect((await read()).blocks.find((b: any) => b.id === block.id).content.text).toBe(
      'Concurrent server edit',
    );
    await expect.poll(async () => (await read()).runs.length).toBe(2);
    await expect
      .poll(async () => (await read()).runs.every((r: any) => r.status === 'completed'))
      .toBe(true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exit;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
