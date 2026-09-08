import { abortable } from './abort.js';
import { statfs } from 'node:fs/promises';
import { lifecycleLog } from './logging.js';
export type DiskState = 'checking' | 'healthy' | 'low' | 'unknown';
type Probe = (path: string) => Promise<{ bavail: number; bsize: number }>;
export class DiskMonitor {
  private state: DiskState = 'checking';
  private checkedAt?: number;
  private low = false;
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  constructor(
    private paths: string[],
    private minFreeBytes: number,
    private intervalMs: number,
    private probe: Probe = statfs,
    private log = lifecycleLog,
    private clock = Date.now,
  ) {}
  get status(): DiskState {
    return this.checkedAt !== undefined && this.clock() - this.checkedAt > this.intervalMs * 2
      ? 'unknown'
      : this.state;
  }
  get allowsWrites() {
    return this.status === 'healthy';
  }
  check(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.inspect().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async inspect() {
    const previous = this.state;
    let freeBytes = 0;
    try {
      const disks = await abortable(
        Promise.all(this.paths.map((path) => this.probe(path))),
        AbortSignal.timeout(5000),
      );
      freeBytes = Math.min(...disks.map((s) => s.bavail * s.bsize));
      if (!Number.isFinite(freeBytes) || freeBytes < 0) throw new Error('Invalid disk sample');
      // Require 25% headroom above the floor to resume after a low-space event.
      const threshold = this.low ? this.minFreeBytes * 1.25 : this.minFreeBytes;
      this.low = freeBytes < threshold;
      this.state = this.low ? 'low' : 'healthy';
    } catch {
      this.state = 'unknown';
    }
    this.checkedAt = this.clock();
    if (this.state !== previous || this.state !== 'healthy')
      this.log('disk_state', { state: this.state, freeBytes, minimumBytes: this.minFreeBytes });
  }
  async start() {
    await this.check();
    this.timer = setInterval(() => void this.check(), this.intervalMs);
    this.timer.unref();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.pending;
  }
}
