import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pdfFixture } from '../tests/fixtures/pdf';

test('PDF originals, page text, frozen context and unavailable representations in the built app', async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'membrane-pdf-'));
  const origin = 'http://127.0.0.1:4185';
  const child = spawn(process.execPath, ['dist-server/main.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: '4185',
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
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  try {
    await expect.poll(() => output).toContain('mem-brane API');
    expect(
      (
        await page.request.post(`${origin}/api/auth/sign-up/email`, {
          data: { name: 'Reader', email: 'reader@test.com', password: 'browser-test-password' },
          headers: { origin },
        })
      ).ok(),
    ).toBeTruthy();
    const brane = await (
      await page.request.post(`${origin}/api/branes`, { data: { title: 'PDF research' } })
    ).json();
    await page.goto(`${origin}/b/${brane.id}?view=focus`);
    const original = pdfFixture(['Evidence on page one', 'Conclusion on page two']);
    await page
      .locator('input[type=file]')
      .setInputFiles({ name: 'Research.pdf', mimeType: 'application/pdf', buffer: original });
    const download = page.getByRole('link', { name: 'Download original PDF' });
    await expect(download).toBeVisible();
    const bytes = await page.request.get(
      (await download.getAttribute('href'))!.replace('/api/', `${origin}/api/`),
    );
    expect(bytes.headers()['content-type']).toContain('application/pdf');
    expect(bytes.headers()['content-disposition']).toContain('attachment');
    expect(await bytes.body()).toEqual(original);
    await expect(
      page.getByText('Model context uses extracted text by page.', { exact: false }),
    ).toBeVisible();
    await page.getByText('Page 2', { exact: true }).click();
    await expect(page.getByText('Conclusion on page two', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '+ Use as context', exact: true }).click();
    await page.getByRole('textbox', { name: 'Run prompt' }).fill('Summarize these pages');
    await expect(page.getByRole('button', { name: 'Run ↗', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Run ↗', exact: true }).click();
    const read = async () => (await page.request.get(`${origin}/api/branes/${brane.id}`)).json();
    await expect.poll(async () => (await read()).runs[0]?.status).toBe('completed');
    const run = await (
      await page.request.get(`${origin}/api/runs/${(await read()).runs[0].id}`)
    ).json();
    expect(run.inputs[0].content.representation.pages).toEqual([
      { number: 1, text: 'Evidence on page one' },
      { number: 2, text: 'Conclusion on page two' },
    ]);
    await page.locator('input[type=file]').setInputFiles({
      name: 'Graphics.pdf',
      mimeType: 'application/pdf',
      buffer: pdfFixture(['']),
    });
    await expect
      .poll(async () =>
        (await read()).blocks.some((block: any) => block.content.filename === 'Graphics.pdf'),
      )
      .toBe(true);
    await page
      .locator('.block-outline')
      .getByRole('button', { name: /Graphics.pdf/ })
      .click();
    await expect(page.getByText('Not available as model context:', { exact: false })).toContainText(
      'OCR',
    );
    await expect(page.getByRole('button', { name: 'Spawn', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '+ Use as context', exact: true }).click();
    await page.getByRole('textbox', { name: 'Run prompt' }).fill('Read the scan');
    await expect(page.getByRole('button', { name: 'Run ↗', exact: true })).toBeDisabled();
    await expect(page.getByRole('alert')).toContainText('OCR');
    await page.screenshot({ path: '/tmp/membrane-pdf-ui.png' });
  } finally {
    child.kill('SIGTERM');
    await exit;
    rmSync(directory, { recursive: true, force: true });
  }
});
