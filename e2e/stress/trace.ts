import type { Page, TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { summarizeTrace, type TraceEvent } from '../../scripts/trace-summary';
export async function startTrace(page: Page, info: TestInfo) {
  const session = await page.context().newCDPSession(page);
  const events: TraceEvent[] = [];
  // CDP declares these opaque JSON events as string maps even though their
  // timestamps, durations and profile payloads are numeric/structured values.
  session.on('Tracing.dataCollected', ({ value }) =>
    events.push(...(value as unknown as TraceEvent[])),
  );
  await session.send('Tracing.start', {
    categories:
      'devtools.timeline,v8.execute,blink.user_timing,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack,disabled-by-default-v8.cpu_profiler',
    options: 'record-as-much-as-possible',
  });
  return async () => {
    const complete = new Promise<{ dataLossOccurred: boolean }>((resolve) =>
      session.once('Tracing.tracingComplete', resolve),
    );
    await session.send('Tracing.end');
    const result = await complete;
    const phases = summarizeTrace(events);
    const path = info.outputPath('browser.trace.json');
    await writeFile(path, JSON.stringify({ traceEvents: events }));
    await info.attach('browser-trace', { path, contentType: 'application/json' });
    await info.attach('trace-summary', {
      body: JSON.stringify({ dataLossOccurred: result.dataLossOccurred, phases }, null, 2),
      contentType: 'application/json',
    });
    await session.detach();
    if (result.dataLossOccurred) throw new Error('Chrome reported trace data loss.');
    if (!phases.length) throw new Error('No complete stress phases were captured.');
  };
}
