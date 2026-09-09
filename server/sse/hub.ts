import { EventEmitter } from 'node:events';
import type { RunEvent } from '../../shared/contracts.js';
export type { RunEvent } from '../../shared/contracts.js';
export class EventHub {
  private events = new EventEmitter();
  private shutdown = new AbortController();
  get signal() {
    return this.shutdown.signal;
  }
  close() {
    this.shutdown.abort();
  }
  constructor() {
    this.events.setMaxListeners(1000);
  }
  publish(actor: string, event: RunEvent) {
    this.events.emit(actor, event);
  }
  subscribe(actor: string, listener: (event: RunEvent) => void) {
    this.events.on(actor, listener);
    return () => {
      this.events.off(actor, listener);
    };
  }
}
