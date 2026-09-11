import type { Reporter, TestCase, TestResult, FullResult } from '@playwright/test/reporter';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { cpus, platform, release, arch } from 'node:os';
import type { StressMeasurement } from '../e2e/stress/metrics';
import type { summarizeTrace } from './trace-summary';
type Result = {
  browser: string;
  browserVersion: string;
  selectors: string;
  traced: boolean;
  trace?: { dataLossOccurred: boolean; phases: ReturnType<typeof summarizeTrace>; path?: string };
  cardCount: number;
  streamIntervalMs: number;
  measurements: StressMeasurement[];
  status: string;
};
export default class StressReporter implements Reporter {
  private results: Result[] = [];
  onTestEnd(test: TestCase, result: TestResult) {
    const attachment = result.attachments.find((a) => a.name === 'stress-metrics');
    if (attachment?.path) {
      const measured: Result = {
        ...JSON.parse(readFileSync(attachment.path, 'utf8')),
        status: result.status,
      };
      const summary = result.attachments.find((a) => a.name === 'trace-summary');
      const summaryText = summary?.path
        ? readFileSync(summary.path, 'utf8')
        : summary?.body?.toString();
      if (summaryText) measured.trace = JSON.parse(summaryText);
      const trace = result.attachments.find((a) => a.name === 'browser-trace');
      if (trace?.path && measured.trace) {
        mkdirSync('artifacts/stress/traces', { recursive: true });
        measured.trace.path = `traces/${measured.browser}-${measured.selectors}.json`;
        copyFileSync(trace.path, `artifacts/stress/${measured.trace.path}`);
      }
      this.results.push(measured);
    }
  }
  onEnd(result: FullResult) {
    const report = {
      recordedAt: new Date().toISOString(),
      status: result.status,
      revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      dirty: !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
      host: {
        platform: platform(),
        release: release(),
        arch: arch(),
        cpu: cpus()[0]?.model,
        node: process.version,
      },
      methodology:
        'Production React profiling build, 1440×1000 headless browsers, one worker. All 500 card nodes remain mounted; four streams update every 50 ms. Transport is simulated. No live model or backend is used. Input measurements are double-rAF upper bounds on a paint opportunity, not physical display latency. Profiler counts are card-subtree commits, not component function calls. Timing thresholds are broad regression guards, not a frame-rate guarantee.',
      results: this.results,
    };
    const lines = [
      '# Canvas stress measurements',
      '',
      `Recorded: ${report.recordedAt}. Outcome: ${report.status}.`,
      '',
      report.methodology,
      '',
      `Host: ${report.host.cpu}, ${report.host.platform} ${report.host.release} (${report.host.arch}); Node ${report.host.node}.`,
      '',
      `Revision: ${report.revision}${report.dirty ? ' with working-tree changes' : ''}.`,
      '',
      '| Browser | Phase / input | Samples | Median (ms) | p95 (ms) | Max (ms) |',
      '| --- | --- | ---: | ---: | ---: | ---: |',
    ];
    const details: string[] = [];
    for (const engine of this.results) {
      const name = `${engine.browser} ${engine.browserVersion}${engine.traced ? ` / ${engine.selectors}, traced` : ''}`;
      for (const phase of engine.measurements) {
        for (const [kind, timing] of Object.entries(phase.inputs))
          lines.push(
            `| ${name} | ${phase.phase} / ${kind} | ${timing.count} | ${timing.median.toFixed(1)} | ${timing.p95.toFixed(1)} | ${timing.max.toFixed(1)} |`,
          );
      }
      const isolated = engine.measurements.find((m) => m.phase === 'stream-only');
      if (isolated) {
        const active = Object.entries(isolated.cardSubtreeCommits);
        details.push(
          '',
          `${name}: streaming alone committed ${active.length} card subtrees (${active.map(([id, n]) => `${id}: ${n}`).join(', ')}). Workspace React render duration p95: ${isolated.reactRenderDurationMs.p95.toFixed(1)} ms.`,
        );
      }
    }
    lines.push(...details);
    lines.push(
      '',
      '| Browser / selectors | Phase | Frame gap max (ms) | Tasks over 50 ms | Longest task (ms) | Sampled selector work (ms) | Sampled assertion snapshots (ms) | Layout (ms) | Paint (ms) |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    );
    for (const engine of this.results)
      for (const phase of engine.measurements) {
        const trace = engine.trace?.phases.find((p) => p.phase === phase.phase);
        lines.push(
          `| ${engine.browser} / ${engine.selectors} | ${phase.phase} | ${phase.frameIntervalsMs.max.toFixed(1)} | ${trace?.mainThreadTasks.over50Ms ?? 'untraced'} | ${trace?.mainThreadTasks.maxMs.toFixed(1) ?? '—'} | ${trace?.sampledSelectorMs.toFixed(1) ?? '—'} | ${trace?.sampledSnapshotMs.toFixed(1) ?? '—'} | ${trace?.layoutMs.toFixed(1) ?? '—'} | ${trace?.paintMs.toFixed(1) ?? '—'} |`,
        );
      }
    for (const engine of this.results)
      if (engine.trace?.path)
        lines.push(
          '',
          `[${engine.selectors} browser trace](${engine.trace.path}); trace data loss: ${engine.trace.dataLossOccurred}. CPU sampling estimates and nested task/layout/paint durations are separate measurements and must not be added together.`,
        );
    const stem = process.env.STRESS_TRACE === '1' ? 'trace-comparison' : 'latest';
    lines.push(
      '',
      `Raw samples, frame gaps with timestamps/focus state, Event Timing availability and all subtree commit counts are in [${stem}.json](${stem}.json).`,
      '',
      'Physical-device coverage and the hands-on protocol are recorded in docs/interaction-verification.md.',
      '',
    );
    mkdirSync('artifacts/stress', { recursive: true });
    writeFileSync(`artifacts/stress/${stem}.json`, JSON.stringify(report, null, 2) + '\n');
    writeFileSync(`artifacts/stress/${stem}.md`, lines.join('\n'));
  }
}
