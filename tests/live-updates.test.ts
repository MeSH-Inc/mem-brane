import { afterEach, expect, it, vi } from 'vitest';
import { connectLiveUpdates, type LiveSource } from '../src/services/live-updates';

afterEach(() => vi.useRealTimers());
class FakeSource implements LiveSource {
  readyState = 0;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private listeners = new Map<string, ((event: Event) => void)[]>();
  addEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string) {
    this.readyState = 1;
    for (const listener of this.listeners.get(type) ?? []) listener(new Event(type));
  }
  fail(readyState: number) {
    this.readyState = readyState;
    this.onerror?.(new Event('error'));
  }
}
function fixture() {
  vi.useFakeTimers();
  const sources: FakeSource[] = [];
  const events = { reconcile: 0, connected: [] as boolean[], types: [] as string[] };
  const stop = connectLiveUpdates({
    open: () => {
      const source = new FakeSource();
      sources.push(source);
      return source;
    },
    eventTypes: ['ready', 'run'],
    onEvent: (type) => events.types.push(type),
    onReconcile: () => events.reconcile++,
    onConnected: (connected) => events.connected.push(connected),
    initialDelayMs: 100,
    maximumDelayMs: 300,
  });
  return { sources, events, stop };
}

it('leaves a network retry to the browser but replaces a closed stream with backoff', () => {
  const f = fixture();
  f.sources[0].emit('ready');
  f.sources[0].fail(0);
  expect(f.sources).toHaveLength(1);
  expect(f.events.reconcile).toBe(0);
  f.sources[0].fail(2);
  expect(f.events).toMatchObject({ reconcile: 1, connected: [true, false] });
  vi.advanceTimersByTime(99);
  expect(f.sources).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(f.sources).toHaveLength(2);
  f.sources[1].fail(2);
  vi.advanceTimersByTime(199);
  expect(f.sources).toHaveLength(2);
  vi.advanceTimersByTime(1);
  expect(f.sources).toHaveLength(3);
  f.sources[2].fail(2);
  vi.advanceTimersByTime(300);
  f.sources[3].fail(2);
  vi.advanceTimersByTime(300);
  expect(f.sources).toHaveLength(5);
  expect(f.events.reconcile).toBe(4);
});

it('resets the backoff once a stream is ready, and stops reconnecting when closed', () => {
  const f = fixture();
  f.sources[0].fail(2);
  vi.advanceTimersByTime(100);
  f.sources[1].fail(2);
  vi.advanceTimersByTime(200);
  f.sources[2].emit('ready');
  f.sources[2].emit('run');
  expect(f.events.types).toEqual(['ready', 'run']);
  expect(f.events.connected.at(-1)).toBe(true);
  f.sources[2].fail(2);
  vi.advanceTimersByTime(100);
  expect(f.sources).toHaveLength(4);
  f.sources[3].fail(2);
  f.stop();
  vi.advanceTimersByTime(1000);
  expect(f.sources).toHaveLength(4);
  expect(f.sources[3].closed).toBe(true);
});
