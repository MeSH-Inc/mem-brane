// Chrome trace timestamps are microseconds. CPU samples are estimates; task,
// layout and paint durations are separate, nested measurements, not additive.
export interface TraceEvent {
  name: string;
  ph: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
  id?: string;
  args?: {
    data?: {
      startTime?: number;
      cpuProfile?: { nodes?: ProfileNode[]; samples?: number[] };
      timeDeltas?: number[];
    };
  };
}
interface ProfileNode {
  id: number;
  parent?: number;
  callFrame: { functionName: string; scriptId: string | number };
}
const overlap = (start: number, end: number, from: number, to: number) =>
  Math.max(0, Math.min(end, to) - Math.max(start, from));
export function summarizeTrace(events: TraceEvent[]) {
  const ordered = [...events].sort((a, b) => a.ts - b.ts);
  const open = new Map<string, TraceEvent>();
  const phases: { phase: string; pid: number; tid: number; start: number; end: number }[] = [];
  for (const event of ordered) {
    const match = /^stress:phase:(.+):(start|end)$/.exec(event.name);
    if (!match) continue;
    const key = `${event.pid}:${event.tid}:${match[1]}`;
    if (match[2] === 'start') open.set(key, event);
    else {
      const start = open.get(key);
      if (start)
        phases.push({
          phase: match[1],
          pid: event.pid,
          tid: event.tid,
          start: start.ts,
          end: event.ts,
        });
      open.delete(key);
    }
  }
  const profiles = new Map<
    string,
    {
      cursor: number;
      nodes: Map<number, ProfileNode>;
      samples: { start: number; end: number; id: number }[];
      pid: number;
      tid: number;
    }
  >();
  for (const event of ordered) {
    // Chrome may emit chunks on its profiler thread. Profile's tid identifies
    // the sampled thread; the profile id is scoped to the process.
    const key = `${event.pid}:${event.id}`;
    if (event.name === 'Profile')
      profiles.set(key, {
        cursor: event.args?.data?.startTime ?? event.ts,
        nodes: new Map(),
        samples: [],
        pid: event.pid,
        tid: event.tid,
      });
    if (event.name !== 'ProfileChunk') continue;
    const profile = profiles.get(key),
      data = event.args?.data;
    if (!profile || !data) continue;
    for (const node of data.cpuProfile?.nodes ?? []) profile.nodes.set(node.id, node);
    for (const [i, id] of (data.cpuProfile?.samples ?? []).entries()) {
      const end = profile.cursor + Math.max(0, data.timeDeltas?.[i] ?? 0);
      profile.samples.push({ start: profile.cursor, end, id });
      profile.cursor = end;
    }
  }
  return phases.map((phase) => {
    const timed = ordered.filter(
      (e) =>
        e.pid === phase.pid &&
        e.tid === phase.tid &&
        e.ph === 'X' &&
        overlap(e.ts, e.ts + (e.dur ?? 0), phase.start, phase.end) > 0,
    );
    const duration = (event: TraceEvent) =>
      overlap(event.ts, event.ts + (event.dur ?? 0), phase.start, phase.end) / 1000;
    const tasks = timed.filter((e) => e.name === 'RunTask').map(duration);
    let selectorMs = 0;
    let snapshotMs = 0;
    for (const profile of profiles.values()) {
      if (profile.pid !== phase.pid || profile.tid !== phase.tid) continue;
      // queryRole identifies Playwright's injected selector script. Avoid
      // classifying the application's own querySelectorAll calls as automation.
      const injected = new Set(
        [...profile.nodes.values()]
          .filter((n) =>
            ['queryRole', 'ariaSnapshotForExpectFailure'].includes(n.callFrame.functionName),
          )
          .map((n) => String(n.callFrame.scriptId)),
      );
      for (const sample of profile.samples) {
        const ms = overlap(sample.start, sample.end, phase.start, phase.end) / 1000;
        if (!ms) continue;
        let node = profile.nodes.get(sample.id);
        const visited = new Set<number>();
        let selector = false;
        let snapshot = false;
        while (node && !visited.has(node.id)) {
          visited.add(node.id);
          if (
            injected.has(String(node.callFrame.scriptId)) &&
            ['queryRole', 'querySelectorAll'].includes(node.callFrame.functionName)
          ) {
            selector = true;
          }
          if (
            injected.has(String(node.callFrame.scriptId)) &&
            node.callFrame.functionName === 'ariaSnapshotForExpectFailure'
          )
            snapshot = true;
          node = node.parent === undefined ? undefined : profile.nodes.get(node.parent);
        }
        if (selector) selectorMs += ms;
        if (snapshot) snapshotMs += ms;
      }
    }
    return {
      phase: phase.phase,
      durationMs: (phase.end - phase.start) / 1000,
      mainThreadTasks: {
        count: tasks.length,
        over50Ms: tasks.filter((t) => t > 50).length,
        maxMs: Math.max(0, ...tasks),
      },
      sampledSelectorMs: selectorMs,
      sampledSnapshotMs: snapshotMs,
      layoutMs: timed.filter((e) => e.name === 'Layout').reduce((n, e) => n + duration(e), 0),
      styleMs: timed
        .filter((e) => e.name === 'UpdateLayoutTree')
        .reduce((n, e) => n + duration(e), 0),
      paintMs: timed.filter((e) => e.name === 'Paint').reduce((n, e) => n + duration(e), 0),
    };
  });
}
