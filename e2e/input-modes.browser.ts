import { test, expect, type Page, type CDPSession } from '@playwright/test';
import type { BraneState } from '../shared/types/domain';
let writes: string[];
test.beforeEach(async ({ page }) => {
  writes = [];
  const state: BraneState = {
    brane: { id: 'b', title: 'Native input ownership', created_at: 0, updated_at: 0 },
    blocks: ['a', 'b'].map((id) => ({
      id,
      kind: 'text',
      origin: id === 'a' ? 'authored' : 'generated',
      version: 0,
      content: { format: 'text', text: `${id} · Scroll and select this content.\n`.repeat(60) },
    })),
    placements: ['a', 'b'].map((id, i) => ({
      id: 'p' + id,
      block_id: id,
      brane_id: 'b',
      x: 100 + i * 400,
      y: 100,
      width: 320,
      height: 260,
      version: 0,
      z_index: 0,
    })),
    runs: [],
    derivations: [],
  };
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname,
      method = route.request().method();
    let result: unknown = {};
    if (method !== 'GET') {
      writes.push(path);
      const body = route.request().postDataJSON();
      if (path.startsWith('/api/placements/')) {
        const placement = state.placements.find((p) => path.endsWith(p.id))!;
        expect(body.version).toBe(placement.version);
        Object.assign(placement, body, { version: placement.version + 1 });
        result = placement;
      } else if (path === '/api/blocks/live') {
        const block = state.blocks.find((b) => b.id === body.blockId)!;
        block.version++;
        block.content.text = body.text;
        result = { version: block.version, content: block.content };
      }
    } else if (path === '/api/branes/b') result = state;
    else if (path === '/api/config')
      result = {
        models: ['mock'],
        defaultModel: 'mock',
        modelCapabilities: {},
        imports: { maxBytes: 5000 },
        maxOutputTokens: 100,
        dailySpendEnforced: true,
        budget: { day: '2026-09-11', committedMicrousd: 0, availableMicrousd: 0, limitMicrousd: 0 },
      };
    await route.fulfill({ json: result });
  });
  await page.goto('/e2e/canvas.html?view=canvas');
  await expect(page.locator('[data-id="pa"] textarea')).toBeVisible();
});
const viewport = (page: Page) => page.locator('.react-flow__viewport');
test('Tab reaches cards and native controls; keyboard selection toggles and editing never moves cards', async ({
  page,
  browserName,
}) => {
  // WebKit on macOS preserves the native Option-Tab path through buttons.
  const optionTab = browserName === 'webkit' && process.platform === 'darwin';
  const forward = optionTab ? 'Alt+Tab' : 'Tab';
  const backward = optionTab ? 'Alt+Shift+Tab' : 'Shift+Tab';
  const card = page.locator('[data-id="pa"]');
  await page.getByLabel('Artifact canvas', { exact: true }).focus();
  await page.keyboard.press(forward);
  await expect(card).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(card).toHaveClass(/selected/);
  await page.keyboard.press('Shift+Enter');
  await expect(card).not.toHaveClass(/selected/);
  await page.keyboard.press('Space');
  await expect(card).toHaveClass(/selected/);
  await page.keyboard.press(forward);
  await expect(card.getByRole('button', { name: '↗', exact: true })).toBeFocused();
  await page.keyboard.press(forward);
  const editor = card.getByRole('textbox');
  await expect(editor).toBeFocused();
  await page.keyboard.type('Editable ');
  await page.keyboard.press('Shift+ArrowLeft');
  expect(
    await editor.evaluate((el: HTMLTextAreaElement) => el.selectionEnd - el.selectionStart),
  ).toBe(1);
  await expect(editor).toHaveValue(/Editable /);
  expect(writes.filter((path) => path.includes('/placements/'))).toEqual([]);
  await page.keyboard.press(backward);
  await page.keyboard.press(backward);
  await expect(card).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => writes.filter((path) => path.includes('/placements/')).length).toBe(1);
  await expect(card).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 105, 100)');
});
test('wheel scrolls native content, pans the overview, and modified wheel zooms around the pointer', async ({
  page,
}) => {
  await page.getByRole('button', { name: '✥ Pan', exact: true }).click();
  const camera = await viewport(page).getAttribute('style');
  for (const selector of ['[data-id="pa"] textarea', '[data-id="pb"] .response-content']) {
    const content = page.locator(selector);
    await content.hover();
    await page.mouse.wheel(0, 160);
    await expect.poll(() => content.evaluate((el) => el.scrollTop)).toBeGreaterThan(50);
    await expect(viewport(page)).toHaveAttribute('style', camera!);
  }
  const host = (await page.locator('.canvas-host').boundingBox())!;
  await page.mouse.move(host.x + 25, host.y + 25);
  await page.mouse.wheel(35, 25);
  await expect(viewport(page)).not.toHaveAttribute('style', camera!);
  const before = await viewport(page).evaluate(
    (el) => new DOMMatrix(getComputedStyle(el).transform).a,
  );
  const clientWidth = await page.evaluate(() => innerWidth);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -50);
  await page.keyboard.up('Control');
  await expect
    .poll(() => viewport(page).evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a))
    .toBeGreaterThan(before);
  expect(await page.evaluate(() => innerWidth)).toBe(clientWidth);
  expect(writes).toEqual([]);
});
test.describe('emulated touch input', () => {
  test.use({ hasTouch: true });
  for (const tool of ['Select', 'Write', 'Pan']) {
    test(`${tool} allows native taps without replacing placement selection`, async ({ page }) => {
      await page.locator('[data-id="pb"] .card-grip').click();
      await page
        .getByRole('group', { name: 'Canvas tools' })
        .getByRole('button', { name: tool })
        .click();
      const editor = page.locator('[data-id="pa"] textarea');
      await editor.tap();
      await expect(editor).toBeFocused();
      await page
        .locator('[data-id="pa"]')
        .getByRole('button', { name: '+ Use as context', exact: true })
        .tap();
      await expect(page.locator('.context-chips .chip')).toHaveCount(1);
      await expect(page.locator('[data-id="pb"]')).toHaveClass(/selected/);
      await expect(page.locator('[data-id="pa"]')).not.toHaveClass(/selected/);
      expect(writes).toEqual([]);
    });
  }
  test('trusted touch scrolls the editor, pans the canvas and pinches across native content', async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(
      browserName !== 'chromium',
      'Playwright exposes multi-touch injection through Chromium CDP; taps above run in every engine.',
    );
    const session = await context.newCDPSession(page);
    const editor = page.locator('[data-id="pa"] textarea');
    const box = (await editor.boundingBox())!;
    const camera = await viewport(page).getAttribute('style');
    await swipe(
      session,
      page,
      { x: box.x + 100, y: box.y + box.height - 25 },
      { x: box.x + 100, y: box.y + 25 },
    );
    await expect.poll(() => editor.evaluate((el) => el.scrollTop)).toBeGreaterThan(60);
    await expect(viewport(page)).toHaveAttribute('style', camera!);
    const host = (await page.locator('.canvas-host').boundingBox())!;
    await swipe(
      session,
      page,
      { x: host.x + 15, y: host.y + 25 },
      { x: host.x + 65, y: host.y + 25 },
    );
    await expect(viewport(page)).not.toHaveAttribute('style', camera!);
    const before = await viewport(page).evaluate(
      (el) => new DOMMatrix(getComputedStyle(el).transform).a,
    );
    const fresh = (await editor.boundingBox())!;
    const first = { id: 1, x: host.x + 15, y: fresh.y + 50 },
      second = { id: 2, x: fresh.x + 100, y: fresh.y + 50 };
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first] });
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [first, second],
    });
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [first, { ...second, x: second.x + 90 }],
    });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect
      .poll(() => viewport(page).evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a))
      .toBeGreaterThan(before + 0.1);
    expect(writes).toEqual([]);
  });
});
async function swipe(
  session: CDPSession,
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ id: 1, ...from }],
  });
  for (let n = 1; n <= 10; n++) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { id: 1, x: from.x + ((to.x - from.x) * n) / 10, y: from.y + ((to.y - from.y) * n) / 10 },
      ],
    });
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
