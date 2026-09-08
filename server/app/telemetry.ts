import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { DB } from '../db/index.js';
import { lifecycleLog } from './logging.js';
export class Telemetry {
  private delay = monitorEventLoopDelay({ resolution: 20 });
  private timer?: ReturnType<typeof setInterval>;
  private peakRss = 0;
  constructor(
    private db: DB,
    private intervalMs: number,
    private onFatal: (error: unknown) => void,
  ) {}
  start() {
    this.delay.enable();
    this.timer = setInterval(() => {
      try {
        this.sample();
      } catch (error) {
        this.stop();
        this.onFatal(error);
      }
    }, this.intervalMs);
    this.timer.unref();
  }
  sample() {
    const rss = process.memoryUsage().rss;
    this.peakRss = Math.max(this.peakRss, rss);
    const queued = this.db
      .prepare("SELECT count(*) count, MIN(created_at) oldest FROM runs WHERE status='queued'")
      .get() as { count: number; oldest: number | null };
    lifecycleLog('runtime_sample', {
      rssBytes: rss,
      peakSampledRssBytes: this.peakRss,
      eventLoopP99Ms: Number((this.delay.percentile(99) / 1e6).toFixed(2)),
      eventLoopMaxMs: Number((this.delay.max / 1e6).toFixed(2)),
      queuedRuns: queued.count,
      oldestQueuedMs: queued.oldest === null ? 0 : Date.now() - queued.oldest,
    });
    this.delay.reset();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.delay.disable();
  }
}
