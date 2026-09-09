import { test, expect } from '@playwright/test';
import type { BraneState } from '../shared/types/domain';

for (const mode of ['explicit Focus', 'mobile default'] as const) {
  test(`${mode} defers the canvas and keeps navigation usable while it loads`, async ({ page }) => {
    if (mode === 'mobile default') await page.setViewportSize({ width: 390, height: 844 });
    const state: BraneState = {
      brane: { id: 'b', title: 'Deferred canvas', created_at: 0, updated_at: 0 },
      blocks: [
        {
          id: 'a',
          kind: 'text',
          origin: 'authored',
          version: 0,
          content: { format: 'text', text: 'Focus first' },
        },
      ],
      placements: [
        {
          id: 'pa',
          brane_id: 'b',
          block_id: 'a',
          x: 0,
          y: 0,
          width: 320,
          height: 220,
          z_index: 0,
          version: 0,
        },
      ],
      runs: [],
      derivations: [],
    };
    await page.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({
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
                    day: '2026-09-08',
                    committedMicrousd: 0,
                    availableMicrousd: 0,
                    limitMicrousd: 0,
                  },
                }
              : {},
      });
    });
    let canvasRequests = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/src/canvas/BraneCanvas.tsx*', async (route) => {
      canvasRequests++;
      await gate;
      await route.continue();
    });
    try {
      await page.goto(`/e2e/canvas.html${mode === 'explicit Focus' ? '?view=focus' : ''}`);
      await expect(page.getByRole('textbox', { name: 'Block text', exact: true })).toHaveValue(
        'Focus first',
      );
      expect(canvasRequests).toBe(0);
      await page.getByRole('button', { name: 'Canvas', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Loading canvas' })).toBeVisible();
      expect(canvasRequests).toBe(1);
      // Returning to Focus must not wait for the canvas network request.
      await page.getByRole('button', { name: 'Focus', exact: true }).click();
      await expect(page.getByRole('textbox', { name: 'Block text', exact: true })).toHaveValue(
        'Focus first',
      );
      release();
      await page.getByRole('button', { name: 'Canvas', exact: true }).click();
      await expect(page.locator('.react-flow__node[data-id="pa"]')).toBeVisible();
      expect(canvasRequests).toBe(1);
    } finally {
      release();
    }
  });
}
