import { test, expect } from '@playwright/test';
import type { BraneState, Placement } from '../shared/types/domain';

test('delayed saves retain newer moves, conflicts pause, and explicit retry uses the latest version', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const state: BraneState = {
    brane: { id: 'b', title: 'Geometry concurrency', created_at: 0, updated_at: 0 },
    blocks: [
      {
        id: 'a',
        kind: 'text',
        origin: 'authored',
        version: 0,
        content: { format: 'text', text: 'Move me' },
      },
    ],
    placements: [
      {
        id: 'pa',
        brane_id: 'b',
        block_id: 'a',
        x: 100,
        y: 100,
        width: 320,
        height: 220,
        z_index: 0,
        version: 0,
      },
    ],
    runs: [],
    derivations: [],
  };
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const edits: Array<{ x: number; version: number }> = [];
  let stale: Placement | undefined;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path === '/api/placements/pa' && method === 'PATCH') {
      const edit = route.request().postDataJSON();
      edits.push(edit);
      if (edits.length === 1) {
        await gate;
        Object.assign(state.placements[0], edit, { version: 1 });
        stale = { ...state.placements[0] };
      } else if (edits.length === 2) {
        // Another tab committed before this queued write reached the server.
        Object.assign(state.placements[0], { x: 500, version: 2 });
        await route.fulfill({ status: 409, json: { error: 'This placement changed elsewhere.' } });
        return;
      } else {
        expect(edit.version).toBe(state.placements[0].version);
        Object.assign(state.placements[0], edit, { version: edit.version + 1 });
      }
      await route.fulfill({ json: { ...state.placements[0] } });
      return;
    }
    if (path === '/api/placements/pa') {
      await route.fulfill({ json: state.placements[0] });
      return;
    }
    if (path === '/api/branes/b') {
      await route.fulfill({ json: state });
      return;
    }
    await route.fulfill({
      json:
        path === '/api/config'
          ? { models: ['mock'], defaultModel: 'mock', modelCapabilities: {}, budget: {} }
          : {},
    });
  });
  await page.goto('/e2e/canvas.html');
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  const card = page.locator('.react-flow__node[data-id="pa"]');
  await card.locator('.card-grip').click();
  await card.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => edits.length).toBe(1);
  const firstX = edits[0].x;
  await expect(card).toHaveCSS('transform', `matrix(1, 0, 0, 1, ${firstX}, 100)`);
  await page.keyboard.press('ArrowRight');
  const latestX = firstX + 5;
  await expect(card).toHaveCSS('transform', `matrix(1, 0, 0, 1, ${latestX}, 100)`);
  expect(edits).toHaveLength(1);
  releaseFirst();
  await expect(page.getByText(/Placement changes are unsaved/)).toBeVisible();
  expect(edits[1]).toMatchObject({ x: latestX, version: 1 });
  await expect(card).toHaveCSS('transform', `matrix(1, 0, 0, 1, ${latestX}, 100)`);
  await card.focus();
  await page.keyboard.press('ArrowRight');
  const newestX = latestX + 5;
  await expect(card).toHaveCSS('transform', `matrix(1, 0, 0, 1, ${newestX}, 100)`);
  expect(edits).toHaveLength(2);
  await page.getByRole('button', { name: 'Save my latest placement', exact: true }).click();
  await expect.poll(() => edits.length).toBe(3);
  expect(edits[2]).toMatchObject({ x: newestX, version: 2 });
  await expect(page.getByText(/Placement changes are unsaved/)).toHaveCount(0);
  await expect(card).toHaveCSS('transform', `matrix(1, 0, 0, 1, ${newestX}, 100)`);
  // A delayed pre-save snapshot must not undo the acknowledged geometry.
  await page.route('**/api/branes/b', (route) =>
    route.fulfill({ json: { ...state, placements: [stale!] } }),
  );
  const refreshed = page.waitForResponse('**/api/branes/b');
  await page.evaluate(() => window.dispatchEvent(new Event('brane:reconcile')));
  await refreshed;
  await expect(card).toHaveCSS('transform', `matrix(1, 0, 0, 1, ${newestX}, 100)`);
  expect(errors).toEqual([]);
});
