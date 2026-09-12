import type { OcrService } from '../services/ocr.js';

// The database owns claims and financial liabilities. This scheduler only owns
// process lifetime, dispatch gates and cancellation of its in-flight transports.
export class OcrWorker {
  private timer?: ReturnType<typeof setInterval>;
  private active = new Map<Promise<boolean>, AbortController>();
  private stopping = false;
  private failed = false;
  constructor(
    private service: OcrService,
    private canClaim: () => boolean,
    private onFatal: (error: unknown) => void,
  ) {}
  get healthy() {
    return !this.failed && !this.stopping;
  }
  start() {
    this.tick();
    if (!this.stopping) this.timer = setInterval(() => this.tick(), 250);
  }
  tick() {
    if (this.stopping) return;
    try {
      if (!this.canClaim()) return;
      this.service.recover();
      if (!this.service.enabled) return;
      while (this.active.size < this.service.limits.globalConcurrency) {
        const controller = new AbortController();
        const promise = this.service.runNext(
          controller.signal,
          () => !this.stopping && this.canClaim(),
        );
        this.active.set(promise, controller);
        void promise.catch((error) => this.fail(error)).finally(() => this.active.delete(promise));
      }
    } catch (error) {
      this.fail(error);
    }
  }
  private fail(error: unknown) {
    if (this.failed) return;
    this.failed = true;
    this.stopping = true;
    clearInterval(this.timer);
    for (const controller of this.active.values()) controller.abort(new Error('OCR worker failed'));
    this.onFatal(error);
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    for (const controller of this.active.values()) controller.abort(new Error('Server shutdown'));
    await Promise.allSettled(this.active.keys());
  }
}
