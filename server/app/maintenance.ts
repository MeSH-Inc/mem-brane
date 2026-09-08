import type { DB } from '../db/index.js';
import { maintainHistory, type RetentionPolicy } from '../services/retention.js';
import { lifecycleLog } from './logging.js';
export class Maintenance {
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private db: DB,
    private policy: RetentionPolicy,
    private onFatal: (error: unknown) => void,
  ) {}
  start() {
    this.timer = setInterval(() => {
      try {
        const counts = maintainHistory(this.db, this.policy);
        if (Object.values(counts).some(Boolean)) lifecycleLog('history_cleanup', counts);
      } catch (error) {
        this.stop();
        this.onFatal(error);
      }
    }, 60000);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
