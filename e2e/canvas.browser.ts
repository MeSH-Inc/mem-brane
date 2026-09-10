import { test, expect } from '@playwright/test';
import type { BraneState } from '../shared/types/domain';
test('view switching, multi-selection, resize during streaming, and keyboard persistence', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const state: BraneState = {
    brane: { id: 'b', title: 'Canvas regression', created_at: 0, updated_at: 0 },
    blocks: [
      {
        id: 'a',
        kind: 'text',
        origin: 'authored',
        version: 0,
        content: { format: 'text', text: 'First thought' },
      },
      {
        id: 'c',
        kind: 'text',
        origin: 'generated',
        version: 0,
        content: { format: 'text', text: '' },
      },
    ],
    placements: ['a', 'c'].map((id, i) => ({
      id: 'p' + id,
      block_id: id,
      brane_id: 'b',
      x: i * 400,
      y: 0,
      width: 320,
      height: 220,
      z_index: 0,
      version: 0,
    })),
    derivations: [],
    runs: [
      {
        id: 'run',
        brane_id: 'b',
        status: 'running',
        model: 'mock',
        provider: 'mock',
        output_block_id: 'c',
        partial: 'Initial stream',
        error: null,
        usage_json: null,
        retry_of: null,
        created_at: 0,
      },
    ],
  };
  state.placements.push({ ...state.placements[0], id: 'pa2', y: 350 });
  const writes: unknown[] = [];
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    let response: unknown = {};
    if (url.pathname === '/api/branes/b') response = state;
    else if (url.pathname === '/api/config')
      response = {
        models: ['mock'],
        defaultModel: 'mock',
        imports: { maxBytes: 5000 },
        maxOutputTokens: 100,
        dailySpendEnforced: true,
        modelCapabilities: { mock: { vision: false, pdfText: true } },
        budget: {
          day: '2026-09-08',
          committedMicrousd: 0,
          availableMicrousd: 1000000,
          limitMicrousd: 1000000,
        },
      };
    else if (url.pathname === '/api/budget')
      response = {
        day: '2026-09-08',
        committedMicrousd: 0,
        availableMicrousd: 1000000,
        limitMicrousd: 1000000,
      };
    else if (url.pathname.startsWith('/api/placements/') && route.request().method() === 'PATCH') {
      const geometry = route.request().postDataJSON();
      writes.push(geometry);
      const placement = state.placements.find((p) => p.id === url.pathname.split('/').pop())!;
      expect(geometry.version).toBe(placement.version);
      Object.assign(placement, geometry, { version: placement.version + 1 });
      response = placement;
    } else throw new Error(`Unexpected API request: ${route.request().method()} ${url.pathname}`);
    await route.fulfill({ json: response });
  });
  await page.goto('/e2e/canvas.html');
  // Start on the production route so toggles preserve the BraneView instance, as in the app.
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  const first = page.locator('.react-flow__node[data-id="pa"]');
  const second = page.locator('.react-flow__node[data-id="pc"]');
  await expect(first).toBeVisible();
  await first.locator('.card-grip').click();
  await expect(first).toHaveClass(/selected/);
  await page.getByRole('button', { name: 'Focus', exact: true }).click();
  await expect(first).toHaveCount(0);
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  await expect(first).toHaveClass(/selected/);
  await second.locator('.card-grip').click({ modifiers: ['Shift'] });
  await expect(first).toHaveClass(/selected/);
  await expect(second).toHaveClass(/selected/);
  await expect(page.getByRole('button', { name: 'Use 2 as context', exact: true })).toBeVisible();
  await second.locator('.card-grip').click({ modifiers: ['Shift'] });
  await expect(second).not.toHaveClass(/selected/);
  const duplicate = page.locator('.react-flow__node[data-id="pa2"]');
  await duplicate.locator('.card-grip').click({ modifiers: ['Shift'] });
  await expect(first).toHaveClass(/selected/);
  await expect(duplicate).toHaveClass(/selected/);
  await page.getByRole('button', { name: 'Use 1 as context', exact: true }).click();
  await expect(page.locator('.context-chips .chip')).toHaveCount(1);
  const handle = first.locator('[data-resize="se"]');
  const bounds = await handle.boundingBox();
  if (!bounds) throw new Error('Missing resize handle');
  const before = await first.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 85, bounds.y + 65, { steps: 8 });
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('brane:run', {
        detail: { braneId: 'b', runId: 'run', text: 'Updated during resize' },
      }),
    ),
  );
  await expect(second).toContainText('Updated during resize');
  const during = await first.boundingBox();
  expect(during!.width).toBeGreaterThan(before!.width + 50);
  await page.mouse.up();
  await expect.poll(() => writes.length).toBe(1);
  await expect(first).toHaveCSS('width', `${Math.round(during!.width)}px`);
  await first.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => writes.length).toBeGreaterThan(1);
  await expect(page.getByText('Something went wrong!', { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
