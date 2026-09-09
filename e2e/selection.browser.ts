import { test, expect, type Page } from '@playwright/test';
import type { BraneState } from '../shared/types/domain';

const requests: { path: string; body: unknown }[] = [];
test.beforeEach(async ({ page }) => {
  requests.length = 0;
  const state: BraneState = {
    brane: { id: 'b', title: 'Selection', created_at: 0, updated_at: 0 },
    blocks: ['a', 'b'].map((id) => ({
      id,
      kind: 'text',
      origin: 'authored',
      version: 0,
      content: { format: 'text', text: id },
    })),
    placements: [
      { id: 'pa', block_id: 'a', x: 100, y: 100 },
      { id: 'pb', block_id: 'b', x: 500, y: 100 },
      { id: 'pa2', block_id: 'a', x: 100, y: 430 },
    ].map((p) => ({ ...p, brane_id: 'b', width: 300, height: 220, z_index: 0, version: 0 })),
    runs: [],
    derivations: [],
  };
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let response: unknown = {};
    if (route.request().method() !== 'GET') {
      requests.push({ path, body: route.request().postDataJSON() });
      if (path.startsWith('/api/placements/')) {
        const placement = state.placements.find((p) => path.endsWith(p.id))!;
        const edit = route.request().postDataJSON();
        expect(edit.version).toBe(placement.version);
        Object.assign(placement, edit, { version: placement.version + 1 });
        response = placement;
      }
      if (path === '/api/blocks/text') response = { id: 'created' };
    } else if (path === '/api/branes/b') response = state;
    else if (path === '/api/config')
      response = {
        models: ['mock'],
        defaultModel: 'mock',
        modelCapabilities: {},
        imports: { maxBytes: 5000 },
        maxOutputTokens: 100,
        dailySpendEnforced: true,
        budget: { day: '2026-09-08', committedMicrousd: 0, availableMicrousd: 0, limitMicrousd: 0 },
      };
    await route.fulfill({ json: response });
  });
  await page.goto('/e2e/canvas.html');
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  await expect(page.locator('.react-flow__node[data-id="pa"]')).toBeVisible();
});
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
async function selectTool(page: Page, tool = 'Select') {
  await page
    .getByRole('group', { name: 'Canvas tools' })
    .getByRole('button', { name: tool })
    .click();
}
async function partialDrag(page: Page, id = 'pa', finish = true) {
  const box = (await node(page, id).boundingBox())!;
  await page.mouse.move(box.x - 25, box.y - 25);
  await page.mouse.down();
  await page.mouse.move(box.x + 25, box.y + 25, { steps: 8 });
  if (finish) await page.mouse.up();
}

test('marquee intersects placements independently at multiple zooms and resolves unique context', async ({
  page,
}) => {
  await selectTool(page);
  await expect(page.getByRole('button', { name: '▱ Select', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await partialDrag(page);
  await expect(node(page, 'pa')).toHaveClass(/selected/);
  await expect(node(page, 'pa2')).not.toHaveClass(/selected/);
  await node(page, 'pa2')
    .locator('.card-grip')
    .click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Use 1 as context', exact: true }).click();
  await expect(page.locator('.context-chips .chip')).toHaveCount(1);
  await partialDrag(page, 'pb');
  await expect(node(page, 'pa')).not.toHaveClass(/selected/);
  await expect(node(page, 'pa2')).not.toHaveClass(/selected/);
  await expect(node(page, 'pb')).toHaveClass(/selected/);
  await page.getByRole('button', { name: 'Zoom Out', exact: true }).click();
  await expect.poll(async () => (await node(page, 'pa').boundingBox())!.width).toBeLessThan(290);
  await partialDrag(page);
  await expect(node(page, 'pa')).toHaveClass(/selected/);
  await expect(node(page, 'pb')).not.toHaveClass(/selected/);
  expect(requests).toEqual([]);
});

for (const reason of ['Escape', 'tool', 'pointercancel', 'lostcapture', 'blur'] as const) {
  test(`marquee cancellation via ${reason} restores selection and allows the next drag`, async ({
    page,
  }) => {
    await node(page, 'pb').locator('.card-grip').click();
    await selectTool(page);
    await page.getByRole('button', { name: 'Zoom Out', exact: true }).click();
    await expect.poll(async () => (await node(page, 'pa').boundingBox())!.width).toBeLessThan(290);
    const before = (await node(page, 'pa').boundingBox())!;
    await partialDrag(page, 'pa', false);
    await expect(node(page, 'pa')).toHaveClass(/selected/);
    if (reason === 'Escape') await page.keyboard.press('Escape');
    else if (reason === 'tool')
      await page
        .getByRole('button', { name: '✥ Pan', exact: true })
        .evaluate((el: HTMLButtonElement) => el.click());
    else if (reason === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    else
      await page.locator('.react-flow__pane').evaluate((el, reason) => {
        // Browser cancellation events aren't generated by mouse automation; retain
        // the real captured pointer ID to exercise the lifecycle boundary.
        if (reason === 'lostcapture') el.releasePointerCapture(1);
        else el.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true }));
      }, reason);
    await page.mouse.up();
    await expect(page.locator('.react-flow__selection')).toHaveCount(0);
    await expect(node(page, 'pb')).toHaveClass(/selected/);
    await expect(node(page, 'pa')).not.toHaveClass(/selected/);
    const after = (await node(page, 'pa').boundingBox())!;
    expect(after.x).toBeCloseTo(before.x, 0);
    expect(after.width).toBeCloseTo(before.width, 0);
    await selectTool(page);
    await partialDrag(page);
    await expect(node(page, 'pa')).toHaveClass(/selected/);
    await expect(node(page, 'pb')).not.toHaveClass(/selected/);
    expect(requests).toEqual([]);
  });
}

test('Write cancellation cannot create a block and a fresh Write drag creates once', async ({
  page,
}) => {
  await partialDrag(page, 'pa', false);
  await expect(page.locator('.draft-rectangle')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.draft-rectangle')).toHaveCount(0);
  expect(requests).toEqual([]);
  await partialDrag(page);
  await expect.poll(() => requests.filter((r) => r.path === '/api/blocks/text').length).toBe(1);
});

test('Pan moves the viewport from a header, while Select moves the selected group', async ({
  page,
}) => {
  await selectTool(page, 'Pan');
  const grip = node(page, 'pa').locator('.card-grip');
  const before = (await grip.boundingBox())!;
  await page.mouse.move(before.x + 50, before.y + 15);
  await page.mouse.down();
  await page.mouse.move(before.x + 90, before.y + 55, { steps: 8 });
  await page.mouse.up();
  expect((await grip.boundingBox())!.x).toBeGreaterThan(before.x + 30);
  expect(requests).toEqual([]);
  await selectTool(page);
  await grip.click();
  await node(page, 'pb')
    .locator('.card-grip')
    .click({ modifiers: ['Shift'] });
  const start = (await grip.boundingBox())!;
  await page.mouse.move(start.x + 50, start.y + 15);
  await page.mouse.down();
  await page.mouse.move(start.x + 90, start.y + 55, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(() => requests.filter((r) => r.path.startsWith('/api/placements/')).length)
    .toBe(2);
});

test('Select leaves editor text gestures alone and middle mouse pans', async ({ page }) => {
  await selectTool(page);
  const editor = node(page, 'pa').getByRole('textbox');
  const box = (await editor.boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 20, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('.react-flow__selection')).toHaveCount(0);
  const before = (await node(page, 'pa').boundingBox())!;
  await page.mouse.move(before.x - 30, before.y - 30);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(before.x + 10, before.y + 10, { steps: 5 });
  await page.mouse.up({ button: 'middle' });
  expect((await node(page, 'pa').boundingBox())!.x).toBeGreaterThan(before.x + 30);
  expect(requests).toEqual([]);
});

test('reverse marquee selects several cards and empty canvas click clears them', async ({
  page,
}) => {
  await selectTool(page);
  const a = (await node(page, 'pa').boundingBox())!;
  const b = (await node(page, 'pb').boundingBox())!;
  await page.mouse.move(b.x + b.width + 15, b.y + 25);
  await page.mouse.down();
  await page.mouse.move(a.x - 15, a.y - 15, { steps: 12 });
  await page.mouse.up();
  await expect(node(page, 'pa')).toHaveClass(/selected/);
  await expect(node(page, 'pb')).toHaveClass(/selected/);
  await expect(node(page, 'pa2')).not.toHaveClass(/selected/);
  await page.mouse.click(a.x - 20, a.y - 20);
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
  expect(requests).toEqual([]);
});

test('leaving the canvas cancels an unfinished marquee and retains the original selection', async ({
  page,
}) => {
  await node(page, 'pb').locator('.card-grip').click();
  await selectTool(page);
  await partialDrag(page, 'pa', false);
  await page
    .getByRole('button', { name: 'Focus', exact: true })
    .evaluate((el: HTMLButtonElement) => el.click());
  await page.mouse.up();
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  await expect(node(page, 'pb')).toHaveClass(/selected/);
  await expect(node(page, 'pa')).not.toHaveClass(/selected/);
  await partialDrag(page);
  await expect(node(page, 'pa')).toHaveClass(/selected/);
  expect(requests).toEqual([]);
});
