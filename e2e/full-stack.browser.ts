import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

test('built app saves through navigation, corrects rejected submissions, reconciles output and expires sessions', async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'membrane-browser-'));
  const origin = 'http://127.0.0.1:4181';
  const database = join(directory, 'db.sqlite');
  const child = spawn(process.execPath, ['dist-server/main.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: '4181',
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
    let captured = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      `**/api/branes/${brane.id}`,
      async (route) => {
        const old = await (await route.fetch()).json();
        captured = true;
        await gate;
        await route.fulfill({ json: old });
      },
      { times: 1 },
    );
    await page.evaluate(() => window.dispatchEvent(new Event('brane:reconcile')));
    await expect.poll(() => captured).toBe(true);
    await page
      .getByRole('textbox', { name: 'Block text', exact: true })
      .fill('Saved across navigation');
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`${origin}/api/branes/${brane.id}`)).json()).blocks.find(
            (b: any) => b.id === block.id,
          ).content.text,
      )
      .toBe('Saved across navigation');
    await expect(page.getByRole('status')).not.toContainText('Unsaved edits');
    const late = page.waitForResponse(`${origin}/api/branes/${brane.id}`);
    release();
    await late;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(page.getByRole('textbox', { name: 'Block text', exact: true })).toHaveValue(
      'Saved across navigation',
    );
    await page.goto(origin);
    await page.goto(`${origin}/b/${brane.id}?view=focus`);
    await expect(page.getByRole('textbox', { name: 'Block text', exact: true })).toHaveValue(
      'Saved across navigation',
    );
    await page.route(
      '**/api/runs',
      async (route) => {
        await route.fulfill({ status: 400, json: { error: 'Fixture rejection' } });
      },
      { times: 1 },
    );
    await page.getByRole('textbox', { name: 'Run prompt' }).fill('Rejected prompt');
    await page.getByRole('button', { name: 'Run ↗', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Fixture rejection');
    await page.getByRole('textbox', { name: 'Run prompt' }).fill('Corrected prompt');
    await page.getByRole('button', { name: 'Run ↗', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`${origin}/api/branes/${brane.id}`)).json()).runs[0]
            ?.status,
      )
      .toBe('completed');
    await page.reload();
    const state = await (await page.request.get(`${origin}/api/branes/${brane.id}`)).json();
    const run = await (await page.request.get(`${origin}/api/runs/${state.runs[0].id}`)).json();
    expect(run.inputs.find((input: any) => input.kind === 'prompt').content.text).toBe(
      'Corrected prompt',
    );
    const db = new Database(database);
    db.prepare('DELETE FROM session').run();
    db.close();
    // A normal application refresh discovers expiration and returns to authentication.
    await page.evaluate(() => window.dispatchEvent(new Event('brane:reconcile')));
    await expect(page.getByRole('heading', { name: 'Pick up a thought.' })).toBeVisible();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exit;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
