import type { ProfilerOnRenderCallback } from 'react';
export type VisualProperty = 'transform' | 'selected' | 'value' | 'class';
export type InputSample = { label: string; event: string; milliseconds: number };
export type TimingSummary = { count: number; median: number; p95: number; max: number };
export function summarize(values: number[]): TimingSummary {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  return { count: sorted.length, median: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? 0 };
}
export class StressMetrics {
  private recording = false;
  private phase = '';
  private cards: Record<string, number> = {};
  private commits: number[] = [];
  private frames: number[] = [];
  private lastFrame?: number;
  private samples: InputSample[] = [];
  private eventTimings: { name: string; duration: number; interactionId: number }[] = [];
  private armed?: {
    label: string;
    event: string;
    target: Element;
    property: VisualProperty;
    before: string;
  };
  readonly eventTimingSupported = PerformanceObserver.supportedEntryTypes.includes('event');
  constructor() {
    for (const name of ['pointerup', 'pointermove', 'input', 'wheel'])
      window.addEventListener(name, this.capture, { capture: true, passive: true });
    const frame = (now: number) => {
      if (this.recording && this.lastFrame !== undefined) this.frames.push(now - this.lastFrame);
      this.lastFrame = this.recording ? now : undefined;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    if (this.eventTimingSupported) {
      const observer = new PerformanceObserver((list) => {
        if (!this.recording) return;
        for (const entry of list.getEntries()) {
          const event = entry as PerformanceEventTiming & { interactionId?: number };
          this.eventTimings.push({
            name: event.name,
            duration: event.duration,
            interactionId: event.interactionId ?? 0,
          });
        }
      });
      observer.observe({ type: 'event', durationThreshold: 16 } as PerformanceObserverInit);
    }
  }
  onRender: ProfilerOnRenderCallback = (id, phase, actualDuration) => {
    if (!this.recording || phase === 'mount') return;
    if (id === 'workspace') this.commits.push(actualDuration);
    else this.cards[id] = (this.cards[id] ?? 0) + 1;
  };
  reset(phase: string) {
    this.phase = phase;
    this.cards = {};
    this.commits = [];
    this.frames = [];
    this.lastFrame = undefined;
    this.samples = [];
    this.eventTimings = [];
    this.recording = true;
  }
  arm(label: string, event: string, selector: string, property: VisualProperty) {
    if (this.armed) throw new Error('An input measurement is already armed.');
    const target = document.querySelector(selector);
    if (!target) throw new Error(`Missing measurement target: ${selector}`);
    this.armed = { label, event, target, property, before: this.visual(target, property) };
  }
  private visual(target: Element, property: VisualProperty): string {
    if (property === 'value') return (target as HTMLTextAreaElement).value;
    if (property === 'selected') return String(target.classList.contains('selected'));
    if (property === 'class') return target.getAttribute('class') ?? '';
    return (target as HTMLElement).style.transform;
  }
  private capture = (event: Event) => {
    const sample = this.armed;
    if (
      !sample ||
      event.type !== sample.event ||
      (event.type === 'pointermove' && !(event as PointerEvent).buttons)
    )
      return;
    this.armed = undefined;
    const start = performance.now();
    const changed = () => {
      if (this.visual(sample.target, sample.property) === sample.before) {
        if (performance.now() - start < 2000) requestAnimationFrame(changed);
        return;
      }
      // The changed visual state is observable before this frame paints. The
      // following rAF supplies a portable upper bound on that paint opportunity.
      // This includes one frame of measurement overhead, not display latency.
      requestAnimationFrame(() =>
        this.samples.push({
          label: sample.label,
          event: event.type,
          milliseconds: performance.now() - start,
        }),
      );
    };
    requestAnimationFrame(changed);
  };
  async wait(label: string) {
    const start = performance.now();
    while (!this.samples.some((s) => s.label === label)) {
      if (performance.now() - start > 3000)
        throw new Error(`No rendered frame observed for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  report() {
    return {
      phase: this.phase,
      metric:
        'Input capture to the animation frame after the visual change; upper bound on a paint opportunity, including one frame of measurement overhead.',
      inputs: Object.fromEntries(
        [...new Set(this.samples.map((s) => s.label.split(':')[0]))].map((kind) => [
          kind,
          summarize(
            this.samples.filter((s) => s.label.startsWith(`${kind}:`)).map((s) => s.milliseconds),
          ),
        ]),
      ),
      inputSamples: [...this.samples],
      frameIntervalsMs: summarize(this.frames),
      reactRenderDurationMs: summarize(this.commits),
      cardSubtreeCommits: { ...this.cards },
      eventTiming: {
        supported: this.eventTimingSupported,
        minimumDurationMs: 16,
        samples: [...this.eventTimings],
      },
    };
  }
}
export type StressMeasurement = ReturnType<StressMetrics['report']>;
