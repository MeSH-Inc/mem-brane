import type { Reporter, TestCase, TestResult, FullResult } from '@playwright/test/reporter';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { cpus, platform, release, arch } from 'node:os';
import type { StressMeasurement } from '../e2e/stress/metrics';
type Result = {
  browser: string;
  browserVersion: string;
  cardCount: number;
  streamIntervalMs: number;
  measurements: StressMeasurement[];
  status: string;
};
export default class StressReporter implements Reporter {
  private results: Result[] = [];
  onTestEnd(test: TestCase, result: TestResult) {
    const attachment = result.attachments.find((a) => a.name === 'stress-metrics');
    if (attachment?.path)
      this.results.push({
        ...JSON.parse(readFileSync(attachment.path, 'utf8')),
        status: result.status,
      });
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
      for (const phase of engine.measurements) {
        for (const [kind, timing] of Object.entries(phase.inputs))
          lines.push(
            `| ${engine.browser} ${engine.browserVersion} | ${phase.phase} / ${kind} | ${timing.count} | ${timing.median.toFixed(1)} | ${timing.p95.toFixed(1)} | ${timing.max.toFixed(1)} |`,
          );
      }
      const isolated = engine.measurements.find((m) => m.phase === 'stream-only');
      if (isolated) {
        const active = Object.entries(isolated.cardSubtreeCommits);
        details.push(
          '',
          `${engine.browser}: streaming alone committed ${active.length} card subtrees (${active.map(([id, n]) => `${id}: ${n}`).join(', ')}). Workspace React render duration p95: ${isolated.reactRenderDurationMs.p95.toFixed(1)} ms.`,
        );
      }
    }
    lines.push(...details);
    lines.push(
      '',
      'Raw samples, frame intervals, Event Timing availability and all subtree commit counts are in [latest.json](latest.json).',
      '',
      'Physical touch, trackpad hardware and installed Safari/iOS still require the hands-on protocol in docs/interaction-verification.md.',
      '',
    );
    mkdirSync('artifacts/stress', { recursive: true });
    writeFileSync('artifacts/stress/latest.json', JSON.stringify(report, null, 2) + '\n');
    writeFileSync('artifacts/stress/latest.md', lines.join('\n'));
  }
}
