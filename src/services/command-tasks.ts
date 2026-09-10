import { createStore } from 'zustand/vanilla';
export type CommandPhase = 'waiting' | 'working' | 'refreshing' | 'accepted' | 'failed';
export type CommandTask = { id: string; phase: CommandPhase; error?: string };
export type CommandProgress = (phase: 'waiting' | 'working' | 'refreshing') => void;
export const commandPending = (task?: CommandTask) =>
  !!task && !['accepted', 'failed'].includes(task.phase);

// Register before invoking work: duplicate activation returns the same promise,
// even before React paints the disabled control. Each entity has its own key.
export class CommandTasks {
  readonly store = createStore<Record<string, CommandTask>>(() => ({}));
  private running = new Map<string, Promise<unknown>>();
  pending(key: string) {
    return commandPending(this.store.getState()[key]);
  }
  activeKeys() {
    return [...this.running.keys()];
  }
  run<T>(key: string, work: (progress: CommandProgress) => Promise<T>): Promise<T> {
    const current = this.running.get(key);
    if (current) return current as Promise<T>;
    const id = crypto.randomUUID();
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const result = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.running.set(key, result);
    const progress: CommandProgress = (phase) => this.store.setState({ [key]: { id, phase } });
    progress('working');
    const done = (task: CommandTask) => {
      this.running.delete(key);
      this.store.setState({ [key]: task });
    };
    try {
      void work(progress).then(
        (value) => {
          done({ id, phase: 'accepted' });
          resolve(value);
        },
        (error) => {
          done({
            id,
            phase: 'failed',
            error: error instanceof Error ? error.message : String(error),
          });
          reject(error);
        },
      );
    } catch (error) {
      done({ id, phase: 'failed', error: error instanceof Error ? error.message : String(error) });
      reject(error);
    }
    return result;
  }
}
