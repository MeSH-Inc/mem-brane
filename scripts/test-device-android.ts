import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import type { StressMeasurement } from '../e2e/stress/metrics';

// Attach to an already running, USB-debuggable Chrome. Only this script's tab
// is operated on; closing the connection does not quit the user's browser.
const endpoint = process.env.ANDROID_CDP_URL;
if (!endpoint) throw new Error('Set ANDROID_CDP_URL to the forwarded Chrome DevTools WebSocket.');
const url =
  process.env.STRESS_DEVICE_URL ?? 'http://127.0.0.1:4180/e2e/stress/index.html?view=canvas';
const browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 10000 });
const page = await browser.contexts()[0].newPage();
const cdp = await page.context().newCDPSession(page);
const directory = process.env.STRESS_DEVICE_OUTPUT ?? 'artifacts/stress/device';
await mkdir(directory, { recursive: true });
const reports: { delayMs: number; passed: string[]; metrics?: StressMeasurement }[] = [];
let failure: string | undefined;
let environment: unknown;
const card = page.locator('[data-id="placement-000"]');
const editor = card.locator('textarea');
const camera = () => page.locator('.react-flow__viewport').getAttribute('style');
const geometry = () => card.evaluate((el) => (el as HTMLElement).style.transform);
async function wait(predicate: () => Promise<boolean>, description: string) {
  const deadline = Date.now() + 10000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
type Point = { x: number; y: number; id?: number };
const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', touchPoints: Point[]) =>
  cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
async function tap(x: number, y: number) {
  await touch('touchStart', [{ id: 1, x, y }]);
  await touch('touchEnd', []);
}
async function swipe(from: Point, to: Point) {
  await touch('touchStart', [{ id: 1, ...from }]);
  for (let i = 1; i <= 10; i++) {
    await touch('touchMove', [
      { id: 1, x: from.x + ((to.x - from.x) * i) / 10, y: from.y + ((to.y - from.y) * i) / 10 },
    ]);
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  await touch('touchEnd', []);
}
try {
  await page.goto(url);
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length === 500);
  environment = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    secure: isSecureContext,
    dpr: devicePixelRatio,
    viewport: { width: innerWidth, height: innerHeight },
  }));
  assert(
    await page.evaluate(
      () => isSecureContext && document.hasFocus() && document.visibilityState === 'visible',
    ),
    'Fixture must be secure and foreground.',
  );
  for (const delayMs of [350, 1500]) {
    const report: (typeof reports)[number] = { delayMs, passed: [] };
    reports.push(report);
    await page.evaluate((delay) => {
      window.stress.server.delayMs = delay;
      window.stress.server.startStreams();
      window.stress.metrics.reset('android-' + delay);
    }, delayMs);
    const before = await camera();
    const box = (await editor.boundingBox())!;
    const scrollBefore = await editor.evaluate((el) => el.scrollTop);
    await swipe({ x: box.x + 100, y: box.y + box.height - 20 }, { x: box.x + 100, y: box.y + 20 });
    await wait(
      async () => (await editor.evaluate((el) => el.scrollTop)) > scrollBefore + 30,
      'native editor scrolling',
    );
    assert.equal(await camera(), before);
    report.passed.push('native editor scroll retains camera');
    const host = (await page.locator('.canvas-host').boundingBox())!;
    await page.evaluate(() =>
      window.stress.metrics.arm('pan:0', 'pointermove', '.react-flow__viewport', 'transform'),
    );
    await swipe({ x: host.x + 15, y: host.y + 25 }, { x: host.x + 55, y: host.y + 25 });
    assert.notEqual(await camera(), before);
    await page.evaluate(() => window.stress.metrics.wait('pan:0'));
    report.passed.push('background touch pan');
    const fresh = (await editor.boundingBox())!;
    const first = { id: 1, x: host.x + 15, y: fresh.y + 50 },
      second = { id: 2, x: fresh.x + 100, y: fresh.y + 50 };
    const scale = () =>
      page
        .locator('.react-flow__viewport')
        .evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
    const scaleBefore = await scale();
    await touch('touchStart', [first]);
    await touch('touchStart', [first, second]);
    await page.evaluate(() =>
      window.stress.metrics.arm('pinch:0', 'pointermove', '.react-flow__viewport', 'transform'),
    );
    await touch('touchMove', [first, { ...second, x: second.x + 70 }]);
    await touch('touchEnd', []);
    await wait(async () => (await scale()) > scaleBefore + 0.1, 'pinch zoom');
    await page.evaluate(() => window.stress.metrics.wait('pinch:0'));
    report.passed.push('pinch with second finger over editor');
    await card.focus();
    if (!(await card.evaluate((el) => el.classList.contains('selected'))))
      await page.keyboard.press('Enter');
    await page.evaluate(() => {
      window.stress.server.hold('placement-000');
      window.stress.server.conflict('placement-000');
    });
    await page.keyboard.press('ArrowRight');
    await wait(
      () =>
        page.evaluate(() =>
          window.stress.server.writes.some((w) => w.id === 'placement-000' && w.status === 0),
        ),
      'held geometry write',
    );
    await page.keyboard.press('ArrowRight');
    const transform = await geometry();
    await page.evaluate(() => window.stress.server.release('placement-000'));
    const conflict = page
      .locator('.error-banner')
      .filter({ hasText: 'Placement changes are unsaved' });
    await conflict.waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await geometry(), transform);
    report.passed.push('newer local geometry survives conflict');
    const ebox = (await editor.boundingBox())!;
    await tap(ebox.x + 70, ebox.y + 30);
    assert(await editor.evaluate((el) => el === document.activeElement));
    for (let i = 0; i < 12; i++) {
      await page.evaluate(
        (i) =>
          window.stress.metrics.arm(
            `typing:${i}`,
            'input',
            '[data-id="placement-000"] textarea',
            'value',
          ),
        i,
      );
      await cdp.send('Input.insertText', { text: 'x' });
      await page.evaluate((i) => window.stress.metrics.wait(`typing:${i}`), i);
    }
    report.passed.push('native text insertion during conflict');
    await conflict.getByRole('button', { name: 'Save my latest placement', exact: true }).click();
    await conflict.waitFor({ state: 'detached', timeout: 10000 });
    assert.equal(await geometry(), transform);
    report.passed.push('retry preserves latest geometry');
    await page.evaluate(() => {
      window.stress.metrics.stop();
      window.stress.server.stopStreams();
    });
    report.metrics = await page.evaluate(() => window.stress.metrics.report());
    await page.screenshot({ path: `${directory}/android-${delayMs}.png` });
    console.log({ delayMs, passed: report.passed, inputs: report.metrics.inputs });
  }
} catch (error) {
  failure = String(error);
  process.exitCode = 1;
} finally {
  await writeFile(
    `${directory}/android-results.json`,
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        status: failure ? 'failed' : 'passed',
        failure,
        revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
        device: process.env.STRESS_DEVICE_LABEL ?? 'Android device (model not specified)',
        browser: browser.version(),
        environment,
        input:
          'CDP-injected touch and text in the attached Chrome. Device model is operator-supplied; this does not measure manual input or display latency.',
        reports,
      },
      null,
      2,
    ) + '\n',
  );
  await page.close();
  await browser.close();
}
if (failure) throw new Error(failure);
