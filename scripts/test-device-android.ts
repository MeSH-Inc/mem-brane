import { connectCdp } from './device-cdp';
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
const browser = await connectCdp(endpoint);
let cdp: Awaited<ReturnType<typeof connectCdp>> | undefined;
let targetId: string | undefined;
let browserVersion: string | undefined;
async function evaluate<T, A = undefined>(fn: (arg: A) => T, arg?: A): Promise<Awaited<T>> {
  const result = await cdp!.send('Runtime.evaluate', {
    expression: `(${fn.toString()})(${JSON.stringify(arg) ?? 'undefined'})`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const box = (selector: string) =>
  evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`Missing element: ${selector}`);
    return el.getBoundingClientRect().toJSON() as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
  }, selector);
const focus = (selector: string) =>
  evaluate((selector) => {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) throw new Error(`Missing element: ${selector}`);
    el.focus();
  }, selector);
async function key(key: string, code: string, windowsVirtualKeyCode: number) {
  await cdp!.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    windowsVirtualKeyCode,
    text: key === 'Enter' ? '\r' : undefined,
  });
  await cdp!.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
}
const directory = process.env.STRESS_DEVICE_OUTPUT ?? 'artifacts/stress/device';
await mkdir(directory, { recursive: true });
const reports: { delayMs: number; passed: string[]; metrics?: StressMeasurement }[] = [];
let failure: string | undefined;
let environment: unknown;
const card = '[data-id="placement-000"]';
const editor = card + ' textarea';
const camera = () =>
  evaluate(() => document.querySelector<HTMLElement>('.react-flow__viewport')!.style.transform);
const geometry = () =>
  evaluate((selector) => document.querySelector<HTMLElement>(selector)!.style.transform, card);
async function wait(predicate: () => Promise<boolean>, description: string) {
  const deadline = Date.now() + 10000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
type Point = { x: number; y: number; id?: number };
const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', touchPoints: Point[]) =>
  cdp!.send('Input.dispatchTouchEvent', { type, touchPoints });
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
    await evaluate(() => new Promise(requestAnimationFrame));
  }
  await touch('touchEnd', []);
}
try {
  browserVersion = (await browser.send('Browser.getVersion')).product;
  ({ targetId } = await browser.send('Target.createTarget', { url: 'about:blank' }));
  const targetUrl = new URL(endpoint);
  targetUrl.pathname = `/devtools/page/${targetId}`;
  cdp = await connectCdp(targetUrl.href);
  await cdp.send('Page.enable');
  await cdp.send('Page.bringToFront');
  await cdp.send('Page.navigate', { url });
  await wait(
    () => evaluate(() => document.querySelectorAll('.react-flow__node').length === 500),
    'mount 500 cards',
  );
  environment = await evaluate(() => ({
    userAgent: navigator.userAgent,
    secure: isSecureContext,
    dpr: devicePixelRatio,
    viewport: { width: innerWidth, height: innerHeight },
  }));
  assert(
    await evaluate(
      () => isSecureContext && document.hasFocus() && document.visibilityState === 'visible',
    ),
    'Fixture must be secure and foreground.',
  );
  for (const delayMs of [350, 1500]) {
    if (reports.length) {
      cdp.close();
      await browser.send('Target.closeTarget', { targetId });
      ({ targetId } = await browser.send('Target.createTarget', { url: 'about:blank' }));
      targetUrl.pathname = `/devtools/page/${targetId}`;
      cdp = await connectCdp(targetUrl.href);
      await cdp.send('Page.enable');
      await cdp.send('Page.bringToFront');
      await cdp.send('Page.navigate', { url });
      await wait(
        () => evaluate(() => document.querySelectorAll('.react-flow__node').length === 500),
        'fresh fixture',
      );
    }
    const report: (typeof reports)[number] = { delayMs, passed: [] };
    reports.push(report);
    await evaluate((delay) => {
      window.stress.server.delayMs = delay;
      window.stress.server.startStreams();
      window.stress.metrics.reset('android-' + delay);
    }, delayMs);
    const before = await camera();
    const bounds = await box(editor);
    const scrollBefore = await evaluate(
      (selector) => document.querySelector(selector)!.scrollTop,
      editor,
    );
    await swipe(
      { x: bounds.x + 100, y: bounds.y + bounds.height - 20 },
      { x: bounds.x + 100, y: bounds.y + 20 },
    );
    await wait(
      async () =>
        (await evaluate((selector) => document.querySelector(selector)!.scrollTop, editor)) >
        scrollBefore + 30,
      'native editor scrolling',
    );
    assert.equal(await camera(), before);
    report.passed.push('native editor scroll retains camera');
    const host = await box('.canvas-host');
    await evaluate(() =>
      window.stress.metrics.arm('pan:0', 'pointermove', '.react-flow__viewport', 'transform'),
    );
    await swipe({ x: host.x + 15, y: host.y + 25 }, { x: host.x + 55, y: host.y + 25 });
    assert.notEqual(await camera(), before);
    await evaluate(() => window.stress.metrics.wait('pan:0'));
    report.passed.push('background touch pan');
    const fresh = await box(editor);
    const first = { id: 1, x: host.x + 15, y: fresh.y + 50 },
      second = { id: 2, x: fresh.x + 100, y: fresh.y + 50 };
    const scale = () =>
      evaluate(
        () =>
          new DOMMatrix(
            getComputedStyle(document.querySelector('.react-flow__viewport')!).transform,
          ).a,
      );
    const scaleBefore = await scale();
    await touch('touchStart', [first]);
    await touch('touchStart', [first, second]);
    await evaluate(() =>
      window.stress.metrics.arm('pinch:0', 'pointermove', '.react-flow__viewport', 'transform'),
    );
    await touch('touchMove', [first, { ...second, x: second.x + 70 }]);
    await touch('touchEnd', []);
    await wait(async () => (await scale()) > scaleBefore + 0.1, 'pinch zoom');
    await evaluate(() => window.stress.metrics.wait('pinch:0'));
    report.passed.push('pinch with second finger over editor');
    await focus(card);
    if (
      !(await evaluate(
        (selector) => document.querySelector(selector)!.classList.contains('selected'),
        card,
      ))
    )
      await key('Enter', 'Enter', 13);
    await evaluate(() => {
      window.stress.server.hold('placement-000');
      window.stress.server.conflict('placement-000');
    });
    await key('ArrowRight', 'ArrowRight', 39);
    await wait(
      () =>
        evaluate(() =>
          window.stress.server.writes.some((w) => w.id === 'placement-000' && w.status === 0),
        ),
      'held geometry write',
    );
    await key('ArrowRight', 'ArrowRight', 39);
    const transform = await geometry();
    await evaluate(() => window.stress.server.release('placement-000'));
    await wait(
      () =>
        evaluate(() =>
          [...document.querySelectorAll('.attention-item')].some((el) =>
            el.textContent?.includes('A card move wasn’t saved'),
          ),
        ),
      'geometry conflict',
    );
    assert.equal(await geometry(), transform);
    report.passed.push('newer local geometry survives conflict');
    const ebox = await box(editor);
    await tap(ebox.x + 70, ebox.y + 30);
    assert(
      await evaluate(
        (selector) => document.querySelector(selector) === document.activeElement,
        editor,
      ),
    );
    for (let i = 0; i < 12; i++) {
      await evaluate(
        (i) =>
          window.stress.metrics.arm(
            `typing:${i}`,
            'input',
            '[data-id="placement-000"] textarea',
            'value',
          ),
        i,
      );
      await cdp!.send('Input.insertText', { text: 'x' });
      await evaluate((i) => window.stress.metrics.wait(`typing:${i}`), i);
    }
    report.passed.push('native text insertion during conflict');
    const retrySelector = await evaluate(() => {
      const item = [...document.querySelectorAll('.attention-item')].find((el) =>
        el.textContent?.includes('A card move wasn’t saved'),
      );
      const button = [...(item?.querySelectorAll('button') ?? [])].find(
        (el) => el.textContent === 'Save my move',
      );
      if (!button) throw new Error('Missing geometry retry');
      button.setAttribute('data-device-retry', '');
      return '[data-device-retry]';
    });
    await focus(retrySelector);
    await key('Enter', 'Enter', 13);
    await wait(
      () =>
        evaluate(
          () =>
            ![...document.querySelectorAll('.attention-item')].some((el) =>
              el.textContent?.includes('A card move wasn’t saved'),
            ),
        ),
      'conflict retry',
    );
    assert.equal(await geometry(), transform);
    report.passed.push('retry preserves latest geometry');
    await evaluate(() => {
      window.stress.metrics.stop();
      window.stress.server.stopStreams();
    });
    report.metrics = await evaluate(() => window.stress.metrics.report());
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(`${directory}/android-${delayMs}.png`, Buffer.from(screenshot.data, 'base64'));
    console.log({ delayMs, passed: report.passed, inputs: report.metrics.inputs });
  }
} catch (error) {
  if (cdp) {
    await writeFile(
      `${directory}/android-failure-dom.txt`,
      await evaluate(() => document.body.innerText).catch(() => 'Page unavailable'),
    ).catch(() => {});
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => undefined);
    if (shot) await writeFile(`${directory}/android-failure.png`, Buffer.from(shot.data, 'base64'));
  }
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
        browser: browserVersion,
        environment,
        input:
          'CDP-injected touch and text in the attached Chrome. Device model is operator-supplied; this does not measure manual input or display latency.',
        reports,
      },
      null,
      2,
    ) + '\n',
  );
  cdp?.close();
  if (targetId) await browser.send('Target.closeTarget', { targetId });
  browser.close();
}
if (failure) throw new Error(failure);
