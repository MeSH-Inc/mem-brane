import type { PendingOperation, ReplicaStorage } from './replica-storage';
import { operationDependencies } from './command-dependencies';
import { replicaGate, replicaLock } from './replica-locks';

// The ordered outbox defines causality, not one account-wide network queue.
// Independent branches dispatch concurrently; a failed dependency blocks only
// descendants. Per-operation locks prevent duplicate dispatch across tabs while
// a shared account lock permits independent work and excludes explicit rebasing.
export class ReplicaScheduler {
  private running = new Map<string, Promise<boolean>>();
  constructor(
    private storage: ReplicaStorage,
    private dispatch: (actor: string, operation: PendingOperation) => Promise<boolean>,
  ) {}
  async synchronize(
    actor: string,
    operations: PendingOperation[],
    valid: () => boolean,
    keys = operations.map((op) => op.key),
  ) {
    const dependencies = operationDependencies(operations);
    const byKey = new Map(operations.map((op) => [op.key, op]));
    const schedule = (key: string): Promise<boolean> => {
      const identity = JSON.stringify([actor, key]);
      const running = this.running.get(identity);
      if (running) return running;
      const operation = byKey.get(key);
      if (!operation) return Promise.resolve(true);
      const before = [...dependencies.get(key)!].map(schedule);
      const result = (async () => {
        if (!(await Promise.all(before)).every(Boolean) || !valid()) return false;
        return replicaLock(replicaGate(actor), 'shared', () =>
          replicaLock(`mem-brane-operation:${actor}:${key}`, 'exclusive', async () => {
            if (!valid()) return false;
            const pending = (await this.storage.read(actor)).pending;
            const current = pending.find((op) => op.key === key);
            if (!current) return true;
            if (current.failure || operationDependencies(pending).get(key)!.size) return false;
            return this.dispatch(actor, current);
          }),
        );
      })();
      this.running.set(identity, result);
      const cleanup = () => {
        if (this.running.get(identity) === result) this.running.delete(identity);
      };
      void result.then(cleanup, cleanup);
      return result;
    };
    return (await Promise.all(keys.map(schedule))).every(Boolean);
  }
}
