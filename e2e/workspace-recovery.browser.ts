import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pdfFixture } from '../tests/fixtures/pdf';
import sharp from 'sharp';

test('mixed-media workflows preserve independent workspace drafts and frozen provenance', async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'membrane-browser-'));
  const origin = 'http://127.0.0.1:4187';
  const database = join(directory, 'db.sqlite');
  const child = spawn(process.execPath, ['dist-server/main.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: '4187',
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
    const title = page.getByRole('textbox', { name: 'Brane title' });
    await page
      .getByRole('textbox', { name: 'Block text', exact: true })
      .fill('Field notes: the north trail floods after heavy rain.');
    await page.getByRole('button', { name: '+ Use as context', exact: true }).click();
    await prompt.fill('Plan a safe route using the evidence');
    await title.fill('Unfinished field study');
    await page.reload();
    await expect(prompt).toHaveValue('Plan a safe route using the evidence');
    await expect(title).toHaveValue('Unfinished field study');
    await expect(page.locator('.context-chips .chip')).toHaveCount(1);

    const other = await page.context().newPage();
    await other.goto(`${origin}/b/${brane.id}?view=focus`);
    await expect(other.getByRole('textbox', { name: 'Run prompt' })).toHaveValue('');
    await other.getByRole('textbox', { name: 'Run prompt' }).fill('Independent tab question');
    await other.getByRole('textbox', { name: 'Brane title' }).fill('Independent title');
    const second = await (
      await page.request.post(`${origin}/api/branes`, { data: { title: 'Separate workspace' } })
    ).json();
    await page.goto(`${origin}/b/${second.id}?view=focus`);
    await expect(prompt).toHaveValue('');
    await expect(title).toHaveValue('Separate workspace');
    await page.goto(`${origin}/b/${brane.id}?view=focus`);
    await expect(prompt).toHaveValue('Plan a safe route using the evidence');
    await expect(title).toHaveValue('Unfinished field study');

    // A save acknowledgement must not erase an edit typed while the request is pending.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let saving = false;
    await page.route(`**/api/branes/${brane.id}`, async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      saving = true;
      await gate;
      await route.continue();
    });
    await page.getByRole('button', { name: 'Save brane', exact: true }).click();
    await expect.poll(() => saving).toBe(true);
    await title.fill('Newer unfinished title');
    release();
    await expect(page.getByRole('status')).toContainText('Brane saved');
    await page.reload();
    await expect(title).toHaveValue('Newer unfinished title');
    await other.reload();
    await expect(other.getByRole('textbox', { name: 'Run prompt' })).toHaveValue(
      'Independent tab question',
    );
    await expect(other.getByRole('textbox', { name: 'Brane title' })).toHaveValue(
      'Independent title',
    );
    await other.close();

    const read = async () => (await page.request.get(`${origin}/api/branes/${brane.id}`)).json();
    // Capture -> Spawn: local note edits are frozen before generation.
    await page.getByRole('button', { name: 'Spawn', exact: true }).click();
    await expect.poll(async () => (await read()).runs[0]?.status).toBe('completed');
    const spawned = (await read()).runs[0];
    const detail = await (await page.request.get(`${origin}/api/runs/${spawned.id}`)).json();
    expect(
      detail.inputs.some(
        (i: any) => i.content.text === 'Field notes: the north trail floods after heavy rain.',
      ),
    ).toBe(true);
    expect(
      detail.inputs.some((i: any) => i.content.text === 'Plan a safe route using the evidence'),
    ).toBe(false);

    await page.locator('input[type=file]').setInputFiles([
      {
        name: 'Trail survey.pdf',
        mimeType: 'application/pdf',
        buffer: pdfFixture(['North trail flood risk: high', 'South trail has raised walkways']),
      },
      {
        name: 'Trail map.png',
        mimeType: 'image/png',
        buffer: await sharp(
          Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#e9efd9"/><path d="M10 60 Q150 140 310 60" fill="none" stroke="#56a6c2" stroke-width="18"/><path d="M20 40 L140 30 L300 40 M20 150 L150 145 L300 150" fill="none" stroke="#755132" stroke-width="5"/><text x="20" y="22">North trail: flood zone</text><text x="20" y="173">South trail: raised walkway</text></svg>',
          ),
        )
          .png()
          .toBuffer(),
      },
    ]);
    await expect
      .poll(
        async () =>
          (await read()).blocks.filter((b: any) => ['pdf', 'image'].includes(b.kind)).length,
      )
      .toBe(2);
    const media = (await read()).blocks.filter((b: any) => ['pdf', 'image'].includes(b.kind));
    for (const item of media) {
      await page.goto(`${origin}/b/${brane.id}?view=focus&focus=${item.id}`);
      await page.getByRole('button', { name: '+ Use as context', exact: true }).click();
    }
    await expect(page.locator('.context-chips .chip')).toHaveCount(3);
    await page.reload();
    await expect(page.locator('.context-chips .chip')).toHaveCount(3);
    await page.getByRole('button', { name: 'Run ↗', exact: true }).click();
    await expect
      .poll(async () => (await read()).runs.filter((r: any) => r.status === 'completed').length)
      .toBe(2);
    const composed = (await read()).runs.find((r: any) => r.id !== spawned.id);
    const composedDetail = await (
      await page.request.get(`${origin}/api/runs/${composed.id}`)
    ).json();
    expect(
      composedDetail.inputs
        .filter((i: any) => i.kind === 'reference')
        .map((i: any) => i.content.format),
    ).toEqual(['text', ...media.map((b: any) => b.content.format)]);
    await expect(prompt).toHaveValue('');
    await page.reload();
    await expect(prompt).toHaveValue('');

    // Branch, inspect frozen provenance, then reopen the source's older snapshot.
    const generated = (await read()).blocks.find((b: any) => b.messageId);
    await page.goto(`${origin}/b/${brane.id}?view=focus&focus=${generated.id}`);
    await page.getByRole('button', { name: '⑂ Continue from here' }).click();
    await prompt.fill('Explain the tradeoffs on this branch');
    await page.reload();
    await expect(page.getByRole('button', { name: '⑂ Continuing a branch ×' })).toBeVisible();
    await page.getByRole('button', { name: 'Run ↗', exact: true }).click();
    await expect
      .poll(async () => (await read()).runs.filter((r: any) => r.status === 'completed').length)
      .toBe(3);
    await page.reload();
    await page.locator('.run-inspect').first().click();
    await expect(page.locator('.frozen-inspector')).toContainText(
      'Explain the tradeoffs on this branch',
    );
    await expect(page.locator('.frozen-inspector')).toContainText(
      'Field notes: the north trail floods after heavy rain.',
    );
    await page.goto(`${origin}/b/${brane.id}?view=focus&focus=${block.id}`);
    await page
      .getByRole('textbox', { name: 'Block text', exact: true })
      .fill('Updated field notes: south trail selected.');
    await page.getByRole('button', { name: 'Block actions', exact: true }).click();
    await page.getByText(/Saved snapshots \(/).click();
    await page
      .locator('.artifact-actions')
      .getByRole('button', { name: /Field notes: the north trail/ })
      .click();
    await expect(page.locator('.artifact-actions pre')).toHaveText(
      'Field notes: the north trail floods after heavy rain.',
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exit;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
