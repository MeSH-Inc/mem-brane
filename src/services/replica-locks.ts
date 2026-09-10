type Mode = 'shared' | 'exclusive';
type Waiter = { mode: Mode; enter(): void };
const locks = new Map<string, { readers: number; writer: boolean; queue: Waiter[] }>();

// Web Locks coordinate tabs. The same fair shared/exclusive semantics are used
// within one realm when Web Locks are unavailable (including headless tests).
export async function replicaLock<T>(name: string, mode: Mode, work: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks)
    return navigator.locks.request(name, { mode }, work);
  let lock = locks.get(name);
  if (!lock) {
    lock = { readers: 0, writer: false, queue: [] };
    locks.set(name, lock);
  }
  const current = lock;
  const pump = () => {
    if (current.writer) return;
    while (current.queue.length) {
      const next = current.queue[0];
      if (next.mode === 'exclusive' && current.readers) return;
      current.queue.shift();
      if (next.mode === 'exclusive') current.writer = true;
      else current.readers++;
      next.enter();
      if (current.writer) return;
    }
  };
  await new Promise<void>((enter) => {
    current.queue.push({ mode, enter });
    pump();
  });
  try {
    return await work();
  } finally {
    if (mode === 'exclusive') current.writer = false;
    else current.readers--;
    pump();
    if (!current.writer && !current.readers && !current.queue.length) locks.delete(name);
  }
}
export const replicaGate = (actor: string) => `mem-brane-replica:${actor}`;
