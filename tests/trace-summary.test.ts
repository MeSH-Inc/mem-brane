import { expect, it } from 'vitest';
import { summarizeTrace, type TraceEvent } from '../scripts/trace-summary';
it('attributes sampled selector work by thread and ancestry and clips tasks at phase boundaries', () => {
  const event = (name: string, ts: number, extra: Partial<TraceEvent> = {}): TraceEvent => ({
    name,
    ts,
    ph: 'X',
    pid: 1,
    tid: 1,
    ...extra,
  });
  const events = [
    event('stress:phase:tools:start', 1000),
    event('stress:phase:tools:end', 121000),
    event('RunTask', 0, { dur: 71000 }),
    event('RunTask', 72000, { dur: 2000 }),
    event('RunTask', 0, { dur: 1000000, tid: 2 }),
    event('Layout', 120000, { dur: 3000 }),
    event('Profile', 0, { id: 'p', ph: 'P', args: { data: { startTime: 0 } } }),
    event('ProfileChunk', 130000, {
      id: 'p',
      tid: 2,
      ph: 'P',
      args: {
        data: {
          cpuProfile: {
            nodes: [
              { id: 1, callFrame: { functionName: 'queryRole', scriptId: 7 } },
              { id: 2, parent: 1, callFrame: { functionName: 'getAccessibleName', scriptId: 7 } },
              { id: 3, callFrame: { functionName: 'querySelectorAll', scriptId: 9 } },
            ],
            samples: [2, 3],
          },
          timeDeltas: [71000, 59000],
        },
      },
    }),
  ];
  expect(summarizeTrace(events)).toEqual([
    {
      phase: 'tools',
      durationMs: 120,
      mainThreadTasks: { count: 2, over50Ms: 1, maxMs: 70 },
      sampledSelectorMs: 70,
      sampledSnapshotMs: 0,
      layoutMs: 1,
      styleMs: 0,
      paintMs: 0,
    },
  ]);
});
it('ignores unclosed phases and handles traces without CPU sampling', () => {
  const events = (['start', 'end'] as const).map((part, i): TraceEvent => ({
    name: `stress:phase:idle:${part}`,
    ts: i * 10000,
    ph: 'I',
    pid: 1,
    tid: 1,
  }));
  expect(summarizeTrace(events.slice(0, 1))).toEqual([]);
  expect(summarizeTrace(events)[0]).toMatchObject({
    durationMs: 10,
    sampledSelectorMs: 0,
    sampledSnapshotMs: 0,
    mainThreadTasks: { count: 0, maxMs: 0, over50Ms: 0 },
  });
});
it('attributes assertion snapshots separately and scopes profile ids to their process', () => {
  const event = (name: string, ts: number, extra: Partial<TraceEvent> = {}): TraceEvent => ({
    name,
    ts,
    ph: 'I',
    pid: 1,
    tid: 1,
    ...extra,
  });
  const profile = (pid: number): TraceEvent[] => [
    event('Profile', 0, { pid, id: 'p', args: { data: { startTime: 0 } } }),
    event('ProfileChunk', 10000, {
      pid,
      tid: 2,
      id: 'p',
      args: {
        data: {
          cpuProfile: {
            nodes: [
              { id: 1, callFrame: { functionName: 'ariaSnapshotForExpectFailure', scriptId: 7 } },
              {
                id: 2,
                parent: 1,
                callFrame: { functionName: 'getTextAlternativeInternal', scriptId: 7 },
              },
            ],
            samples: [2],
          },
          timeDeltas: [10000],
        },
      },
    }),
  ];
  expect(
    summarizeTrace([
      event('stress:phase:faults:start', 0),
      event('stress:phase:faults:end', 10000),
      ...profile(1),
      ...profile(2),
    ])[0],
  ).toMatchObject({ sampledSelectorMs: 0, sampledSnapshotMs: 10 });
});
