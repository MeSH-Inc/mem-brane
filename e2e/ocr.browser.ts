import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { pdfFixture } from '../tests/fixtures/pdf';

test('bounded OCR uploads require credits and consent, recover across reload and preserve frozen model context', async ({
  page,
  context,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'membrane-ocr-browser-'));
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const database = join(directory, 'db.sqlite'),
    origin = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--import', './tests/fixtures/ocr-fetch.ts', 'dist-server/main.js'],
    {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(port),
        APP_ORIGIN: origin,
        DATABASE_PATH: database,
        ASSET_DIRECTORY: join(directory, 'assets'),
        R2_ENDPOINT: '',
        MODEL_ALLOWLIST: 'mock',
        MODEL_DEFAULT: 'mock',
        MODEL_PRICING_JSON: '{}',
        OCR_PROVIDER: 'mistral',
        MISTRAL_API_KEY: 'test-ocr-no-network',
        GLOBAL_DAILY_SPEND_LIMIT: '1',
        GLOBAL_MONTHLY_SPEND_LIMIT: '1',
        OCR_DAILY_SPEND_LIMIT: '1',
        OCR_MONTHLY_SPEND_LIMIT: '1',
        SHUTDOWN_MS: '3000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const exit = once(child, 'exit');
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  const dispatches = () => output.split('OCR_FIXTURE_DISPATCH').length - 1;
  const read = async (path: string) => (await page.request.get(`${origin}/api${path}`)).json();
  try {
    await expect.poll(() => output, { timeout: 10000 }).toContain('mem-brane API');
    const signup = await page.request.post(`${origin}/api/auth/sign-up/email`, {
      headers: { origin },
      data: { name: 'OCR Reader', email: 'ocr@test.com', password: 'browser-test-password' },
    });
    expect(signup.ok()).toBe(true);
    const session = await signup.json();
    const brane = await (
      await page.request.post(`${origin}/api/branes`, { data: { title: 'Enhanced research' } })
    ).json();
    await page.goto(`${origin}/b/${brane.id}?view=focus`);
    await page.locator('input[type=file]').setInputFiles({
      name: 'Scanned research.pdf',
      mimeType: 'application/pdf',
      buffer: pdfFixture(['Original first page', '']),
    });
    await expect(page.getByText('Scanned research.pdf', { exact: true }).first()).toBeVisible();
    await page.getByText('Enhanced PDF extraction', { exact: true }).click();
    await expect(page.getByText('0 page credits available.')).toBeVisible();
    await page.getByRole('button', { name: 'Review page credits' }).click();
    await expect(page.getByRole('button', { name: 'Confirm 2 page credits' })).toBeDisabled();
    expect(dispatches()).toBe(0);
    const db = new Database(database);
    db.prepare('INSERT INTO ocr_credit_grants VALUES (?,?,?,?,?,?)').run(
      crypto.randomUUID(),
      session.user.id,
      'trial',
      50,
      'Invited browser fixture',
      Date.now(),
    );
    db.close();
    await page.reload();
    await page.getByText('Enhanced PDF extraction', { exact: true }).click();
    await expect(page.getByText('50 page credits available.')).toBeVisible();
    await page.getByRole('button', { name: 'Review page credits' }).click();
    await expect(
      page.getByText('Send the original PDF to Mistral for enhanced text extraction.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Keep current extraction' }).click();
    expect(dispatches()).toBe(0);
    const workspace = await read(`/branes/${brane.id}`),
      block = workspace.blocks[0];
    const frozen = await (
      await page.request.post(`${origin}/api/blocks/${block.id}/snapshot`, { data: {} })
    ).json();
    const otherTab = await context.newPage();
    await otherTab.goto(`${origin}/b/${brane.id}?view=focus`);
    await otherTab.getByRole('button', { name: 'Load page text', exact: true }).click();
    await otherTab.getByText('Page 1', { exact: true }).click();
    await expect(otherTab.getByText('Original first page', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Review page credits' }).click();
    await page.getByRole('button', { name: 'Confirm 2 page credits' }).click();
    await expect(page.getByText('Enhanced extraction ready', { exact: true })).toBeVisible();
    await page.getByText('Enhanced page 2', { exact: true }).click();
    await expect(page.getByText('Enhanced scanned text 2', { exact: true })).toBeVisible();
    expect(dispatches()).toBe(1);
    await page.reload();
    await page.getByText('Enhanced PDF extraction', { exact: true }).click();
    await expect(page.getByText('Enhanced extraction ready', { exact: true })).toBeVisible();
    await page
      .getByRole('button', { name: 'Use enhanced text for model context', exact: true })
      .click();
    await expect(
      page.getByText('Enhanced text is used for future model context.', { exact: false }),
    ).toBeVisible();
    await expect(
      otherTab.getByRole('button', { name: 'Load page text', exact: true }),
    ).toBeVisible();
    await otherTab.getByRole('button', { name: 'Load page text', exact: true }).click();
    await otherTab.getByText('Page 1', { exact: true }).click();
    await expect(otherTab.getByText('Enhanced scanned text 1', { exact: true })).toBeVisible();
    expect((await read(`/revisions/${frozen.id}`)).content.representation.pages[0].text).toBe(
      'Original first page',
    );
    await page.getByRole('button', { name: '+ Use as context', exact: true }).click();
    await page.getByRole('textbox', { name: 'Run prompt' }).fill('Summarize the enhanced text');
    await page.getByRole('button', { name: 'Run ↗', exact: true }).click();
    await expect
      .poll(async () => (await read(`/branes/${brane.id}`)).runs[0]?.status)
      .toBe('completed');
    const run = await read(`/runs/${(await read(`/branes/${brane.id}`)).runs[0].id}`);
    expect(run.inputs[0].content.representation.pages).toEqual([
      { number: 1, text: 'Enhanced scanned text 1' },
      { number: 2, text: 'Enhanced scanned text 2' },
    ]);
    expect((await read('/ocr/credits')).committedPages).toBe(2);
    expect(dispatches()).toBe(1);
    await otherTab.close();

    await page.locator('input[type=file]').setInputFiles({
      name: 'Uncertain.pdf',
      mimeType: 'application/pdf',
      buffer: pdfFixture(['uncertain fixture']),
    });
    await expect
      .poll(async () =>
        (await read(`/branes/${brane.id}`)).blocks.some(
          (b: any) => b.content.filename === 'Uncertain.pdf',
        ),
      )
      .toBe(true);
    await page
      .locator('.block-outline')
      .getByRole('button', { name: /Uncertain.pdf/ })
      .click();
    await page.getByText('Enhanced PDF extraction', { exact: true }).click();
    await page.getByRole('button', { name: 'Review page credits' }).click();
    await page.getByRole('button', { name: 'Confirm 1 page credits' }).click();
    await expect(
      page.getByText('Processing or billing needs operator review', { exact: true }),
    ).toBeVisible();
    await page.reload();
    await page.getByText('Enhanced PDF extraction', { exact: true }).click();
    await expect(
      page.getByText('This request will not be sent again.', { exact: false }),
    ).toBeVisible();
    expect((await read('/ocr/credits')).committedPages).toBe(3);
    expect(dispatches()).toBe(2);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exit;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
