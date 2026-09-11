import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import type { StressMeasurement } from '../e2e/stress/metrics';

const ios = process.env.SAFARI_PLATFORM === 'iOS';
const label = ios ? 'ios-safari' : 'macos-safari';
const origin = process.env.SAFARIDRIVER_URL ?? 'http://127.0.0.1:4184';
const url =
  process.env.STRESS_DEVICE_URL ?? 'https://localhost:4188/e2e/stress/index.html?view=canvas';
const directory = process.env.STRESS_DEVICE_OUTPUT ?? 'artifacts/stress/device';
await mkdir(directory, { recursive: true });
let sessionId: string | undefined;
let capabilities: Record<string, unknown> | undefined;
let environment: unknown;
let failure: string | undefined;
let step = 'create session';
const reports: { delayMs: number; passed: string[]; metrics?: StressMeasurement }[] = [];
async function request<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(origin + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  const { value } = await response.json();
  if (!response.ok || value?.error) throw new Error(`${path}: ${value?.error}: ${value?.message}`);
  return value;
}
const call = <T>(path: string, body?: unknown, method?: string) =>
  request<T>(`/session/${sessionId}${path}`, body, method);
const js = <T>(script: string, args: unknown[] = []) => call<T>('/execute/sync', { script, args });
async function wait(script: string, description: string) {
  const deadline = Date.now() + 12000;
  while (!(await js<boolean>(script))) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
const key = (value: string) =>
  call('/actions', {
    actions: [
      {
        type: 'key',
        id: 'keyboard',
        actions: [
          { type: 'keyDown', value },
          { type: 'keyUp', value },
        ],
      },
    ],
  });
type Point = { x: number; y: number };
async function pointer(from: Point, to?: Point) {
  // SafariDriver translates mouse actions into single-finger input on iOS.
  // Do not claim multi-touch coverage from this endpoint.
  const move = (point: Point, duration: number) => ({
    type: 'pointerMove',
    duration,
    origin: 'viewport',
    x: Math.round(point.x),
    y: Math.round(point.y),
  });
  await call('/actions', {
    actions: [
      {
        type: 'pointer',
        id: 'mouse',
        parameters: { pointerType: 'mouse' },
        actions: [
          move(from, 0),
          { type: 'pointerDown', button: 0 },
          ...(to ? [move(to, 250)] : []),
          { type: 'pointerUp', button: 0 },
        ],
      },
    ],
  });
}
const card = '[data-id="placement-000"]';
const editor = card + ' textarea';
const transform = () =>
  js<string>('return document.querySelector(arguments[0]).style.transform', [card]);
const camera = () =>
  js<string>('return document.querySelector(".react-flow__viewport").style.transform');
const box = (selector: string) =>
  js<{ x: number; y: number; width: number; height: number }>(
    'return document.querySelector(arguments[0]).getBoundingClientRect().toJSON()',
    [selector],
  );
async function click(selector: string) {
  const r = await box(selector);
  await pointer({ x: r.x + Math.min(r.width / 2, 70), y: r.y + Math.min(r.height / 2, 20) });
}
async function measured(
  label: string,
  event: string,
  selector: string,
  property: string,
  action: () => Promise<unknown>,
) {
  await js('window.stress.metrics.arm(...arguments)', [label, event, selector, property]);
  await action();
  const result = await call<true | { error: string }>('/execute/async', {
    script:
      'const done=arguments[arguments.length-1]; window.stress.metrics.wait(arguments[0]).then(()=>done(true),e=>done({error:e.message}))',
    args: [label],
  });
  assert.equal(result, true, `No visual response for ${label}: ${JSON.stringify(result)}`);
}
try {
  const created = await request<{ sessionId: string; capabilities: Record<string, unknown> }>(
    '/session',
    {
      capabilities: {
        alwaysMatch: {
          browserName: 'Safari',
          platformName: ios ? 'iOS' : 'mac',
          acceptInsecureCerts: true,
          ...(ios
            ? {
                'safari:useSimulator': false,
                ...(process.env.SAFARI_DEVICE_UDID
                  ? { 'safari:deviceUDID': process.env.SAFARI_DEVICE_UDID }
                  : {}),
              }
            : {}),
        },
      },
    },
  );
  sessionId = created.sessionId;
  capabilities = created.capabilities;
  if (ios) assert.equal(capabilities['safari:useSimulator'], false);
  else {
    await call('/window/rect', { x: 0, y: 0, width: 1440, height: 1000 });
    execFileSync('osascript', ['-e', 'tell application "Safari" to activate']);
  }
  step = 'navigate';
  console.log(label, step);
  await call('/url', { url });
  step = 'mount 500 cards';
  console.log(label, step);
  await wait('return document.querySelectorAll(".react-flow__node").length === 500', step);
  assert(
    await js<boolean>(
      'return isSecureContext && document.hasFocus() && document.visibilityState === "visible"',
    ),
    'Fixture must be secure and foreground.',
  );
  environment = await js(
    'return {userAgent:navigator.userAgent, secure:isSecureContext, dpr:devicePixelRatio, viewport:{width:innerWidth,height:innerHeight}}',
  );
  for (const delayMs of [350, 1500]) {
    const report: (typeof reports)[number] = { delayMs, passed: [] };
    reports.push(report);
    await js(
      'window.stress.server.delayMs=arguments[0];window.stress.server.startStreams();window.stress.metrics.reset(arguments[1])',
      [delayMs, label + '-' + delayMs],
    );
    if (!ios) {
      step = `${delayMs} ms tool switching`;
      console.log(label, step);
      for (let i = 0; i < 12; i++)
        await measured(`tool:${i}`, 'pointerup', '.canvas-host', 'class', () =>
          click(i % 2 ? '.canvas-tools button:nth-child(3)' : '.canvas-tools button:nth-child(2)'),
        );
      report.passed.push('12 Pan/Select switches while streaming');
      await click(card + ' .card-grip');
      assert(
        await js<boolean>(
          'return document.querySelector(arguments[0]).classList.contains("selected")',
          [card],
        ),
      );
      report.passed.push('pointer selection');
    } else {
      step = `${delayMs} ms native scrolling`;
      console.log(label, step);
      const before = await camera(),
        r = await box(editor);
      const oldScroll = await js<number>('return document.querySelector(arguments[0]).scrollTop', [
        editor,
      ]);
      await pointer({ x: r.x + 100, y: r.y + r.height - 20 }, { x: r.x + 100, y: r.y + 20 });
      await wait(
        `return document.querySelector('[data-id="placement-000"] textarea').scrollTop > ${oldScroll + 30}`,
        step,
      );
      assert.equal(await camera(), before);
      report.passed.push('native editor scroll retains camera');
      step = `${delayMs} ms touch pan`;
      console.log(label, step);
      const host = await box('.canvas-host');
      await measured('pan:0', 'pointermove', '.react-flow__viewport', 'transform', () =>
        pointer({ x: host.x + 15, y: host.y + 25 }, { x: host.x + 65, y: host.y + 25 }),
      );
      assert.notEqual(await camera(), before);
      report.passed.push('background single-finger pan');
      await js('document.querySelector(arguments[0]).focus()', [card]);
      if (
        !(await js<boolean>(
          'return document.querySelector(arguments[0]).classList.contains("selected")',
          [card],
        ))
      )
        await key('\ue007');
    }
    step = `${delayMs} ms held geometry`;
    console.log(label, step);
    await js(
      'document.querySelector(arguments[0]).focus();window.stress.server.hold("placement-000");window.stress.server.conflict("placement-000")',
      [card],
    );
    await key('\ue014');
    await wait(
      'return window.stress.server.writes.some(w=>w.id==="placement-000" && w.status===0)',
      step,
    );
    await key('\ue014');
    const latest = await transform();
    await js('window.stress.server.release("placement-000")');
    step = `${delayMs} ms conflict`;
    console.log(label, step);
    await wait('return !!document.querySelector(".error-banner")', step);
    assert.equal(await transform(), latest);
    report.passed.push('newer local geometry survives conflict');
    step = `${delayMs} ms typing`;
    console.log(label, step);
    await click(editor);
    assert(
      await js<boolean>('return document.activeElement === document.querySelector(arguments[0])', [
        editor,
      ]),
    );
    for (let i = 0; i < 12; i++)
      await measured(`typing:${i}`, 'input', editor, 'value', () => key('x'));
    report.passed.push('12 text insertions while conflict visible');
    step = `${delayMs} ms retry`;
    console.log(label, step);
    await click('.error-banner button');
    await wait('return !document.querySelector(".error-banner")', step);
    assert.equal(await transform(), latest);
    report.passed.push('retry preserves latest geometry');
    await js('window.stress.server.stopStreams();window.stress.metrics.stop()');
    report.metrics = await js<StressMeasurement>('return window.stress.metrics.report()');
    console.log({ label, delayMs, passed: report.passed, inputs: report.metrics.inputs });
  }
} catch (error) {
  failure = `${step}: ${String(error)}`;
  process.exitCode = 1;
} finally {
  await writeFile(
    `${directory}/${label}-results.json`,
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        status: failure ? 'failed' : 'passed',
        failure,
        revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
        browser: capabilities?.browserVersion,
        platform: capabilities?.platformName,
        osVersion: capabilities?.['safari:platformVersion'],
        simulator: capabilities?.['safari:useSimulator'],
        device: process.env.STRESS_DEVICE_LABEL,
        environment,
        input:
          'SafariDriver-injected input in installed Safari; not human gestures or hardware keyboard coverage.',
        reports,
      },
      null,
      2,
    ) + '\n',
  );
  if (sessionId) {
    try {
      await call('', undefined, 'DELETE');
    } catch (error) {
      console.error('Could not close owned Safari session:', String(error));
      process.exitCode = 1;
    }
  }
}
if (failure) throw new Error(failure);
