import { test, expect } from '@playwright/test';
import type { BraneState } from '../shared/types/domain';
let state: BraneState;
test.beforeEach(async ({ page }) => {
  state = {
    brane: { id: 'b', title: 'Attention', created_at: 0, updated_at: 0 },
    blocks: ['a', 'b'].map((id) => ({
      id,
      kind: 'text',
      origin: 'authored',
      version: 0,
      content: { format: 'text', text: id },
    })),
    placements: ['a', 'b'].map((id, i) => ({
      id: 'p' + id,
      block_id: id,
      brane_id: 'b',
      x: 100 + i * 400,
      y: 100,
      width: 300,
      height: 220,
      z_index: 0,
      version: 0,
    })),
    runs: [],
    derivations: [],
  };
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({
      json:
        path === '/api/branes/b'
          ? state
          : path === '/api/config'
            ? {
                models: ['mock'],
                defaultModel: 'mock',
                modelCapabilities: {},
                imports: { maxBytes: 5000 },
                maxOutputTokens: 100,
                dailySpendEnforced: true,
                budget: {
                  day: '2026-09-10',
                  committedMicrousd: 0,
                  availableMicrousd: 0,
                  limitMicrousd: 0,
                },
              }
            : {},
    });
  });
  await page.goto('/e2e/canvas.html?view=canvas');
  await page.addStyleTag({ content: '#root {display:flex;flex-direction:column;height:100dvh;}' });
  await expect(page.locator('.react-flow__node[data-id="pa"]')).toBeVisible();
});
function created() {
  state.blocks.push({
    id: 'new',
    kind: 'text',
    origin: 'authored',
    version: 0,
    content: { format: 'text', text: '' },
  });
  state.placements.push({
    id: 'pnew',
    block_id: 'new',
    brane_id: 'b',
    x: 500,
    y: 350,
    width: 300,
    height: 220,
    z_index: 0,
    version: 0,
  });
}
test('camera and focus survive Canvas and Focus round trips', async ({ page }) => {
  await page.locator('[data-id="pb"] .card-grip').click();
  await page.getByRole('button', { name: 'Zoom Out', exact: true }).click();
  await expect
    .poll(async () => (await page.locator('[data-id="pa"]').boundingBox())!.width)
    .toBeLessThan(280);
  const before = await page.locator('.react-flow__viewport').getAttribute('style');
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await page.locator('.block-outline button').nth(1).click();
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  await expect(page.locator('.react-flow__viewport')).toHaveAttribute('style', before!);
  await expect(page.locator('[data-id="pb"]')).toHaveClass(/selected/);
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await expect(page.locator('.focus-card textarea')).toHaveValue('b');
});
test('desktop Focus opens a newly created editor and consumes autofocus', async ({ page }) => {
  await page.route('**/api/blocks/text', async (route) => {
    created();
    await route.fulfill({ json: { id: 'new' } });
  });
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await page.getByRole('button', { name: '＋ Text', exact: true }).click();
  await expect(page.locator('.focus-card textarea')).toHaveValue('');
  await expect(page.locator('.focus-card textarea')).toBeFocused();
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  await expect(page.locator('[data-id="pnew"] textarea')).not.toBeFocused();
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await expect(page.locator('.focus-card textarea')).not.toBeFocused();
});
test('a delayed creation does not steal an editor chosen after the click', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await page.route('**/api/blocks/text', async (route) => {
    await gate;
    created();
    await route.fulfill({ json: { id: 'new' } });
  });
  await page.getByRole('button', { name: '＋ Text', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Creating…', exact: true })).toBeDisabled();
  const editor = page.locator('[data-id="pa"] textarea');
  await editor.click();
  release();
  await expect(page.locator('[data-id="pnew"]')).toBeVisible();
  await expect(editor).toBeFocused();
});

test('creation errors restore the control and preserve the current editor', async ({ page }) => {
  await page.route('**/api/blocks/text', (route) =>
    route.fulfill({ status: 503, json: { error: 'Creation unavailable' } }),
  );
  await page.getByRole('button', { name: '＋ Text', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Creation unavailable');
  await expect(page.getByRole('button', { name: '＋ Text', exact: true })).toBeEnabled();
  await expect(page.locator('[data-id="pa"] textarea')).toHaveValue('a');
});
