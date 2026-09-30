import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testProcessEnvironment } from '../tests/fixtures/process-environment';
import { collectPageErrors } from './page-errors';

test('removed cards survive reload and recover their original identity, content and response provenance', async ({
  page,
}) => {
  const pageErrors = collectPageErrors(page);
  const directory = mkdtempSync(join(tmpdir(), 'membrane-card-recovery-'));
  const origin = 'http://127.0.0.1:4199';
  const child = spawn(process.execPath, ['dist-server/main.js'], {
    env: testProcessEnvironment({
      PORT: '4199',
      APP_ORIGIN: origin,
      DATABASE_PATH: join(directory, 'db.sqlite'),
      ASSET_DIRECTORY: join(directory, 'assets'),
    }),
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
      data: { name: 'Recovery', email: 'recovery@example.com', password: 'browser-test-password' },
      headers: { origin },
    });
    expect(signup.ok()).toBeTruthy();
    const brane = await (
      await page.request.post(`${origin}/api/branes`, { data: { title: 'Recover my cards' } })
    ).json();
    const block = await (
      await page.request.post(`${origin}/api/blocks/text`, { data: { braneId: brane.id } })
    ).json();
    const readWorkspace = async () =>
      (await page.request.get(`${origin}/api/branes/${brane.id}`)).json();
    const removeFocused = async () => {
      await page.locator('.focus-card').getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('button', { name: 'Remove from this brane', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Remove from this brane' })
        .getByRole('button', { name: 'Remove', exact: true })
        .click();
    };
    const openShelf = async () => {
      await page.getByRole('button', { name: '＋ Add', exact: true }).click();
      await page.getByRole('button', { name: 'Unplaced cards', exact: true }).click();
      return page.getByRole('dialog', { name: 'Unplaced cards', exact: true });
    };
    await page.goto(`${origin}/b/${brane.id}?view=focus`);
    const thought = `A thought worth keeping. ${'More context. '.repeat(20)}The preview keeps this ending.`;
    await page.getByRole('textbox', { name: 'Block text', exact: true }).fill(thought);
    await expect.poll(async () => (await readWorkspace()).blocks[0]?.content.text).toBe(thought);
    await removeFocused();
    await expect.poll(async () => (await readWorkspace()).blocks.length).toBe(0);

    // A library-sized page must still lead back to an older, removed card.
    await Promise.all(
      Array.from({ length: 26 }, async () => {
        const other = await (
          await page.request.post(`${origin}/api/blocks/text`, { data: { braneId: brane.id } })
        ).json();
        expect(
          (await page.request.delete(`${origin}/api/placements/${other.placement.id}`)).ok(),
        ).toBeTruthy();
      }),
    );
    await page.reload();
    await page.route(
      '**/api/blocks/unplaced',
      (route) => route.fulfill({ status: 400, json: { error: 'Card list unavailable' } }),
      { times: 1 },
    );
    const shelf = await openShelf();
    await expect(shelf.getByRole('alert')).toContainText('Card list unavailable');
    await shelf.getByRole('button', { name: 'Retry loading cards' }).click();
    await expect(shelf.locator('.unplaced-card')).toHaveCount(25);
    await shelf.getByRole('button', { name: 'Load more cards' }).click();
    await expect(shelf.locator('.unplaced-card')).toHaveCount(27);
    const saved = shelf.locator('.unplaced-card').filter({ hasText: 'A thought worth keeping.' });
    await page.route(
      `**/api/blocks/${block.id}`,
      (route) => route.fulfill({ status: 400, json: { error: 'Preview unavailable' } }),
      { times: 1 },
    );
    await saved.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(saved.getByRole('alert')).toContainText('Preview unavailable');
    await saved.getByRole('button', { name: 'Retry preview' }).click();
    await expect(saved.getByRole('region', { name: 'Card preview' })).toContainText(thought);
    await saved.getByRole('button', { name: 'Show here', exact: true }).click();
    await expect(shelf).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`focus=${block.id}`));
    await expect(page.getByRole('textbox', { name: 'Block text', exact: true })).toHaveValue(
      thought,
    );
    await expect
      .poll(async () => (await readWorkspace()).placements.map((p: any) => p.block_id))
      .toEqual([block.id]);
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Block text', exact: true })).toHaveValue(
      thought,
    );

    await page.getByRole('button', { name: '+ Use as context', exact: true }).click();
    await page.getByRole('textbox', { name: 'Run prompt' }).fill('Develop the saved thought.');
    await page.getByRole('button', { name: 'Run ↗', exact: true }).click();
    await expect.poll(async () => (await readWorkspace()).runs[0]?.status).toBe('completed');
    const before = await readWorkspace();
    const run = before.runs[0];
    const response = before.blocks.find((b: any) => b.id === run.output_block_id);
    const runDetail = await (await page.request.get(`${origin}/api/runs/${run.id}`)).json();
    await page.goto(`${origin}/b/${brane.id}?view=focus&focus=${response.id}`);
    await expect(page.locator('.focus-card .response-content')).toHaveText(response.content.text);
    await removeFocused();
    await expect
      .poll(async () => (await readWorkspace()).blocks.map((b: any) => b.id))
      .toEqual([block.id]);
    await page.reload();
    const responseShelf = await openShelf();
    const savedResponse = responseShelf.locator('.unplaced-card').filter({ hasText: 'Response' });
    await savedResponse.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(savedResponse.getByRole('region', { name: 'Card preview' })).toContainText(
      response.content.text,
    );
    await page.screenshot({ path: join(tmpdir(), 'membrane-unplaced-cards.png') });
    await responseShelf.getByRole('button', { name: 'Close unplaced cards' }).click();
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await page.getByRole('button', { name: 'Show earlier responses', exact: true }).click();
    await page.locator('.earlier-runs li button').click();
    const inputs = page.getByRole('dialog', { name: 'Exact inputs', exact: true });
    await inputs.getByRole('button', { name: 'Preview saved response' }).click();
    await expect(inputs.getByRole('region', { name: 'Saved response preview' })).toContainText(
      response.content.text,
    );
    await expect(inputs.getByRole('region', { name: 'Saved response preview' })).toContainText(
      runDetail.output.revision_id,
    );
    await page.screenshot({ path: join(tmpdir(), 'membrane-response-recovery.png') });
    await inputs.getByRole('button', { name: 'Show response here' }).click();
    await expect(inputs).toHaveCount(0);
    await expect(page.locator('.focus-card .response-content')).toHaveText(response.content.text);
    await expect
      .poll(
        async () =>
          (await readWorkspace()).placements.filter((p: any) => p.block_id === response.id).length,
      )
      .toBe(1);
    const after = await readWorkspace();
    expect(after.blocks.find((b: any) => b.id === response.id).messageId).toBe(response.messageId);
    expect(after.derivations).toEqual(
      before.derivations.map((d: any) => ({
        ...d,
        outputPlacementId: null,
      })),
    );
    expect((await (await page.request.get(`${origin}/api/runs/${run.id}`)).json()).output).toEqual(
      runDetail.output,
    );
    await page.reload();
    await expect(page.locator('.focus-card .response-content')).toHaveText(response.content.text);
    await page.getByRole('button', { name: 'Exact inputs', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Exact inputs' })).toContainText(
      'Develop the saved thought.',
    );
    expect(pageErrors).toEqual([]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await exit;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
