import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

test('image paste, native text paste, mixed picker, drop, navigation and lost-response recovery', async ({
  page,
  context,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'membrane-imports-'));
  const origin = 'http://127.0.0.1:4183';
  const child = spawn(process.execPath, ['dist-server/main.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: '4183',
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
  const png = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#67986d' } })
    .png()
    .toBuffer();
  const read = async (id: string) => (await page.request.get(`${origin}/api/branes/${id}`)).json();
  try {
    await expect.poll(() => output).toContain('mem-brane API');
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    expect(
      (
        await page.request.post(`${origin}/api/auth/sign-up/email`, {
          data: { name: 'Importer', email: 'importer@test.com', password: 'browser-test-password' },
          headers: { origin },
        })
      ).ok(),
    ).toBeTruthy();
    const a = await (
      await page.request.post(`${origin}/api/branes`, { data: { title: 'Import A' } })
    ).json();
    const b = await (
      await page.request.post(`${origin}/api/branes`, { data: { title: 'Import B' } })
    ).json();
    await page.request.post(`${origin}/api/blocks/text`, { data: { braneId: a.id } });
    await page.goto(`${origin}/b/${a.id}?view=focus`);
    const prompt = page.getByRole('textbox', { name: 'Run prompt' });
    await prompt.fill('Read screenshot');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requestSeen = false;
    await page.route(
      '**/api/imports',
      async (route) => {
        requestSeen = true;
        await gate;
        await route.fulfill({ response: await route.fetch() });
      },
      { times: 1 },
    );
    await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) }),
      ]);
    }, png.toString('base64'));
    await prompt.focus();
    await page.keyboard.press('ControlOrMeta+V');
    await expect.poll(() => requestSeen).toBe(true);
    await expect(page.getByAltText(/Preview of/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run ↗', exact: true })).toBeDisabled();
    await page.getByRole('link', { name: /Import B/ }).click();
    release();
    await expect
      .poll(
        async () => (await read(a.id)).blocks.filter((block: any) => block.kind === 'image').length,
      )
      .toBe(1);
    expect((await read(b.id)).blocks).toHaveLength(0);
    await expect(page.locator('.context-chips .chip')).toHaveCount(0);
    await page.getByRole('link', { name: /Import A/ }).click();
    await expect(page.locator('.chip').filter({ hasText: 'image' })).toHaveCount(1);
    // Native paste replaces exactly the editor selection.
    await page.getByRole('button', { name: 'Focus', exact: true }).click();
    const editor = page.getByRole('textbox', { name: 'Block text', exact: true });
    await editor.fill('before after');
    await editor.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(7, 12));
    await page.evaluate(() => navigator.clipboard.writeText('pasted'));
    await editor.focus();
    await page.keyboard.press('ControlOrMeta+V');
    await expect(editor).toHaveValue('before pasted');
    // Picker shares import handling and does not discard supported files in a mixed batch.
    await page.locator('input[type=file]').setInputFiles([
      { name: 'one.png', mimeType: 'image/png', buffer: png },
      { name: 'unsupported.zip', mimeType: 'application/zip', buffer: Buffer.from('zip') },
      { name: 'two.png', mimeType: 'image/png', buffer: png },
    ]);
    await expect(page.getByRole('region', { name: 'File imports' })).toContainText(
      'Unsupported file type',
    );
    await expect
      .poll(
        async () => (await read(a.id)).blocks.filter((block: any) => block.kind === 'image').length,
      )
      .toBe(3);
    const placed = (await read(a.id)).placements;
    expect(new Set(placed.map((p: any) => `${p.x},${p.y}`)).size).toBeGreaterThan(2);
    await page.getByRole('button', { name: 'Canvas', exact: true }).click();
    const canvas = page.getByLabel('Artifact canvas');
    await expect(canvas).toBeVisible();
    const bounds = (await canvas.boundingBox())!;
    await canvas.evaluate(
      (el, { base64, x, y }) => {
        const transfer = new DataTransfer();
        transfer.items.add(
          new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], 'dropped.png', {
            type: 'image/png',
          }),
        );
        el.dispatchEvent(
          new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
            clientX: x,
            clientY: y,
          }),
        );
      },
      { base64: png.toString('base64'), x: bounds.x + 200, y: bounds.y + 180 },
    );
    await expect
      .poll(
        async () => (await read(a.id)).blocks.filter((block: any) => block.kind === 'image').length,
      )
      .toBe(4);
    const dropped = (await read(a.id)).blocks.find(
      (block: any) => block.content.filename === 'dropped.png',
    );
    const placement = (await read(a.id)).placements.find((p: any) => p.block_id === dropped.id);
    expect(placement.x).toBeCloseTo(180, 0);
    expect(placement.y).toBeCloseTo(160, 0);
    // Commit at the server, then lose the response. Retry resolves the receipt, not another upload.
    let deliveries = 0;
    await page.route(
      '**/api/imports',
      async (route) => {
        deliveries++;
        await route.fetch();
        await route.abort('failed');
      },
      { times: 1 },
    );
    await page
      .locator('input[type=file]')
      .setInputFiles({ name: 'uncertain.png', mimeType: 'image/png', buffer: png });
    await expect(page.getByRole('button', { name: 'Retry import' })).toBeVisible();
    await page.getByRole('button', { name: 'Retry import' }).click();
    await expect(page.getByRole('button', { name: 'Retry import' })).toHaveCount(0);
    expect(deliveries).toBe(1);
    expect(
      (await read(a.id)).blocks.filter((block: any) => block.content.filename === 'uncertain.png'),
    ).toHaveLength(1);
    await page.screenshot({ path: '/tmp/membrane-imports-ui.png' });
  } finally {
    child.kill('SIGTERM');
    await exit;
    rmSync(directory, { recursive: true, force: true });
  }
});
