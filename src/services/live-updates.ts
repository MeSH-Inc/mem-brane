// The browser reconnects an EventSource only after a network error. A refused or
// failed response (401 after expiry, 502 from a proxy) closes it for good, and
// running responses would never finish on screen. This keeps one stream open,
// reconnecting with backoff, and asks for a reconcile while it is down so
// durable state still arrives without events.
// The part of EventSource this module uses; readyState 2 is CLOSED.
export interface LiveSource {
  readonly readyState: number;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
}
export interface LiveUpdateOptions {
  open: () => LiveSource;
  onEvent: (type: string, event: Event) => void;
  onReconcile: () => void;
  onConnected: (connected: boolean) => void;
  eventTypes: string[];
  initialDelayMs?: number;
  maximumDelayMs?: number;
}
export function connectLiveUpdates(options: LiveUpdateOptions) {
  const initial = options.initialDelayMs ?? 1000,
    maximum = options.maximumDelayMs ?? 30000;
  let delay = initial;
  let source: LiveSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const connect = () => {
    if (closed) return;
    source = options.open();
    for (const type of options.eventTypes)
      source.addEventListener(type, (event) => {
        if (type === 'ready') {
          delay = initial;
          options.onConnected(true);
        }
        options.onEvent(type, event);
      });
    source.onerror = () => {
      // CONNECTING means the browser is already retrying a network error.
      if (closed || source?.readyState !== 2) return;
      source.close();
      options.onConnected(false);
      options.onReconcile();
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, maximum);
    };
  };
  connect();
  return () => {
    closed = true;
    clearTimeout(timer);
    source?.close();
  };
}
