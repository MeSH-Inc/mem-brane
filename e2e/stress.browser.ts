import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type { StressMeasurement } from './stress/metrics';
const placement = (i: number) => `placement-${String(i).padStart(3, '0')}`;
const selector = (i: number) => `.react-flow__node[data-id="${placement(i)}"]`;
test('500 mounted cards stay responsive under streaming, delayed saves and conflicts', async ({
  page,
  browserName,
  browser,
}, info) => {
  const errors: string[] = [],
    measurements: StressMeasurement[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/e2e/stress/index.html?view=canvas');
  await expect(page.locator('.react-flow__node')).toHaveCount(500);
  const card = page.locator(selector(0));
  await expect(card.getByRole('textbox')).toBeVisible();
  // Let node measurement and initial layout settle before counting updates.
  await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  try {
    const ticks = await page.evaluate(() => {
      window.stress.metrics.reset('stream-only');
      window.stress.server.startStreams();
      return window.stress.server.streamTicks;
    });
    await page.waitForFunction((start) => window.stress.server.streamTicks >= start + 30, ticks);
    const isolated = await page.evaluate(() => window.stress.metrics.report());
    measurements.push(isolated);
    // Fail closed if the profiling build is disabled: zero counts prove nothing.
    expect(Object.keys(isolated.cardSubtreeCommits).sort()).toEqual(
      [1, 2, 4, 5].map((i) => `card:${placement(i)}`).sort(),
    );
    expect(Object.values(isolated.cardSubtreeCommits).every((count) => count >= 20)).toBe(true);
    await page.evaluate(() => window.stress.metrics.reset('tool-switching-with-streams'));
    for (let i = 0; i < 24; i++) {
      await page.evaluate(
        (i) => window.stress.metrics.arm(`tool:${i}`, 'pointerup', '.canvas-host', 'class'),
        i,
      );
      await page.getByRole('button', { name: i % 2 ? '▱ Select' : '✥ Pan', exact: true }).click();
      await page.evaluate((i) => window.stress.metrics.wait(`tool:${i}`), i);
    }
    const tools = await page.evaluate(() => window.stress.metrics.report());
    measurements.push(tools);
    const streaming = [1, 2, 4, 5].map((i) => `card:${placement(i)}`);
    expect(Object.keys(tools.cardSubtreeCommits).filter((id) => !streaming.includes(id))).toEqual(
      [],
    );
    expect(tools.inputs.tool.count).toBe(24);
    expect(tools.inputs.tool.p95).toBeLessThan(100);
    expect(tools.inputs.tool.max).toBeLessThan(250);
    await page.evaluate(() => window.stress.metrics.reset('interaction-with-streams'));
    for (let i = 0; i < 24; i++) {
      await page.evaluate(
        ({ i, selector }) =>
          window.stress.metrics.arm(`click:${i}`, 'pointerup', selector, 'selected'),
        { i, selector: selector(0) },
      );
      await card.locator('.card-grip').click({ modifiers: ['Shift'] });
      await page.evaluate((i) => window.stress.metrics.wait(`click:${i}`), i);
    }
    const bounds = (await card.locator('.card-grip').boundingBox())!;
    await card.locator('.card-grip').click({ position: { x: 60, y: 15 } });
    await page.mouse.move(bounds.x + 60, bounds.y + 15);
    await page.mouse.down();
    for (let i = 0; i < 24; i++) {
      await page.evaluate(
        ({ i, selector }) =>
          window.stress.metrics.arm(`drag:${i}`, 'pointermove', selector, 'transform'),
        { i, selector: selector(0) },
      );
      await page.mouse.move(bounds.x + 72 + i * 2, bounds.y + 15);
      await page.evaluate((i) => window.stress.metrics.wait(`drag:${i}`), i);
    }
    await page.mouse.up();
    const editor = card.getByRole('textbox');
    await editor.click();
    await editor.press('End');
    for (let i = 0; i < 24; i++) {
      await page.evaluate(
        ({ i, selector }) =>
          window.stress.metrics.arm(`typing:${i}`, 'input', `${selector} textarea`, 'value'),
        { i, selector: selector(0) },
      );
      await page.keyboard.type('x');
      await page.evaluate((i) => window.stress.metrics.wait(`typing:${i}`), i);
    }
    const host = (await page.locator('.canvas-host').boundingBox())!;
    await page.mouse.move(host.x + 20, host.y + 20);
    for (let i = 0; i < 24; i++) {
      await page.evaluate(
        (i) =>
          window.stress.metrics.arm(`wheel:${i}`, 'wheel', '.react-flow__viewport', 'transform'),
        i,
      );
      await page.mouse.wheel(i % 2 ? -5 : 5, 0);
      await page.evaluate((i) => window.stress.metrics.wait(`wheel:${i}`), i);
    }
    const input = await page.evaluate(() => window.stress.metrics.report());
    measurements.push(input);
    expect(
      Object.keys(input.cardSubtreeCommits).filter(
        (id) => id !== `card:${placement(0)}` && !streaming.includes(id),
      ),
    ).toEqual([]);
    for (const kind of ['click', 'drag', 'typing', 'wheel']) {
      expect(input.inputs[kind].count).toBe(24);
      // Includes a full frame of measurement overhead. Catch substantial stalls
      // without claiming a universal 60 Hz budget from one headless machine.
      expect(input.inputs[kind].p95).toBeLessThan(100);
      expect(input.inputs[kind].max).toBeLessThan(250);
    }
    await expect
      .poll(() =>
        page.evaluate(() => window.stress.server.writes.every((write) => write.status !== 0)),
      )
      .toBe(true);
    await page.evaluate((id) => {
      window.stress.metrics.reset('faults');
      window.stress.server.hold(id);
      window.stress.server.conflict(id);
    }, placement(0));
    const writesBefore = await page.evaluate(() => window.stress.server.writes.length);
    await card.focus();
    await page.keyboard.press('ArrowRight');
    await expect
      .poll(() => page.evaluate(() => window.stress.server.writes.length))
      .toBe(writesBefore + 1);
    await page.keyboard.press('ArrowRight');
    const localTransform = await card.evaluate((el) => getComputedStyle(el).transform);
    // A different entity persists and cancellation dispatches while A is held.
    const other = page.locator(selector(6));
    await other.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowRight');
    await expect
      .poll(() =>
        page.evaluate(
          (id) => window.stress.server.writes.some((w) => w.id === id && w.status === 200),
          placement(6),
        ),
      )
      .toBe(true);
    await page.getByRole('button', { name: 'Cancel run', exact: true }).first().click();
    await expect
      .poll(() =>
        page.evaluate(() => window.stress.server.state.runs.some((r) => r.status === 'cancelled')),
      )
      .toBe(true);
    expect(
      await page.evaluate(
        (id) => window.stress.server.writes.some((w) => w.id === id && w.status === 0),
        placement(0),
      ),
    ).toBe(true);
    await page.evaluate((id) => window.stress.server.release(id), placement(0));
    await expect(page.getByText(/Placement changes are unsaved/)).toBeVisible();
    await expect(card).toHaveCSS('transform', localTransform);
    // Typing remains responsive while the geometry conflict is visible.
    await editor.click();
    for (let i = 0; i < 12; i++) {
      await page.evaluate(
        ({ i, selector }) =>
          window.stress.metrics.arm(
            `conflict-typing:${i}`,
            'input',
            `${selector} textarea`,
            'value',
          ),
        { i, selector: selector(0) },
      );
      await page.keyboard.type('y');
      await page.evaluate((i) => window.stress.metrics.wait(`conflict-typing:${i}`), i);
    }
    await page.getByRole('button', { name: 'Save my latest placement', exact: true }).click();
    await expect(page.getByText(/Placement changes are unsaved/)).toHaveCount(0);
    await expect(card).toHaveCSS('transform', localTransform);
    const faults = await page.evaluate(() => window.stress.metrics.report());
    measurements.push(faults);
    expect(faults.inputs['conflict-typing'].count).toBe(12);
    expect(faults.inputs['conflict-typing'].p95).toBeLessThan(100);
    expect(faults.inputs['conflict-typing'].max).toBeLessThan(250);
    expect(errors).toEqual([]);
  } finally {
    const latest = await page.evaluate(() => window.stress.metrics.report());
    if (!measurements.some((m) => m.phase === latest.phase)) measurements.push(latest);
    await page.evaluate((id) => {
      window.stress.server.release(id);
      window.stress.server.stopStreams();
    }, placement(0));
    const path = info.outputPath('metrics.json');
    await writeFile(
      path,
      JSON.stringify(
        {
          browser: browserName,
          browserVersion: browser.version(),
          cardCount: 500,
          streamIntervalMs: 50,
          measurements,
        },
        null,
        2,
      ),
    );
    await info.attach('stress-metrics', { path, contentType: 'application/json' });
  }
});
