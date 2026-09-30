import type { DB } from '../db/index.js';
import { maintainHistory, type RetentionPolicy } from '../services/retention.js';
import { reclaimExpiredGuests, deleteGuestObjects } from '../services/guest-reclamation.js';
import type { AssetStore } from '../storage/assets.js';
import { lifecycleLog } from './logging.js';
export class Maintenance {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopping = false;
  private abort = new AbortController();
  constructor(
    private db: DB,
    private policy: RetentionPolicy,
    private storage: AssetStore,
    private onFatal: (error: unknown) => void,
  ) {}
  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), 60000);
    this.timer.unref();
  }
  private tick() {
    if (this.stopping || this.active) return;
    this.active = this.run()
      .catch((error) => {
        this.stopping = true;
        if (this.timer) clearInterval(this.timer);
        this.onFatal(error);
      })
      .finally(() => {
        this.active = undefined;
      });
  }
  private async run() {
    const counts = maintainHistory(this.db, this.policy);
    if (Object.values(counts).some(Boolean)) lifecycleLog('history_cleanup', counts);
    const libraries = reclaimExpiredGuests(this.db, this.policy.batchSize);
    const { deleted, failed } = await deleteGuestObjects(
      this.db,
      this.storage,
      this.policy.batchSize,
      Date.now(),
      this.abort.signal,
    );
    if (libraries || deleted || failed)
      lifecycleLog('guest_cleanup', {
        libraries,
        deletedObjects: deleted,
        failedDeletions: failed,
      });
  }
  async stop() {
    this.stopping = true;
    this.abort.abort();
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
}
