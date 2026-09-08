import { EventEmitter } from 'node:events';
export interface RunEvent {
  type: 'run';
  runId: string;
  braneId: string;
  status?: string;
  text?: string;
}
export class EventHub {
  private events = new EventEmitter();
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
