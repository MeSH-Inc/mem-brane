import type { Block, Geometry, Placement } from '../../shared/types/domain';
import { api, ApiError } from './api';
import { supportedFile } from './import-adapters';
import { indexedImportStorage, type ImportStorage } from './import-storage';
export interface ImportIntent {
  key: string;
  braneId: string;
  target: 'canvas' | 'composer';
  geometry: Geometry;
}
export type ImportResult = Block & { placement: Placement };
export interface ImportTask {
  id: string;
  actor: string;
  intent: ImportIntent;
  filename: string;
  mime: string;
  blob?: Blob;
  status: 'saving' | 'queued' | 'uploading' | 'ready' | 'uncertain' | 'failed' | 'rejected';
  error?: string;
  result?: ImportResult;
  delivered?: boolean;
}
export interface ImportTransport {
  send(task: ImportTask): Promise<ImportResult>;
  status(key: string): Promise<{ state: 'pending' } | { state: 'ready'; result: ImportResult }>;
}
// Shell-owned operations outlive brane routes. Destination and actor never follow navigation.
export class Imports {
  private tasks = new Map<string, ImportTask>();
  private listeners = new Set<() => void>();
  private revision = 0;
  private actor?: string;
  private loading: Promise<void> = Promise.resolve();
  private active = new Set<string>();
  private writes: Promise<unknown> = Promise.resolve();
  maxBytes = 5 * 1024 * 1024;
  recoveryError?: string;
  constructor(
    private storage: ImportStorage,
    private transport: ImportTransport,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.revision;
  private publish() {
    this.revision++;
    this.listeners.forEach((listener) => listener());
  }
  list(braneId?: string) {
    return [...this.tasks.values()].filter(
      (task) => task.actor === this.actor && (!braneId || task.intent.braneId === braneId),
    );
  }
  private persist(task: ImportTask) {
    const write = this.writes.catch(() => {}).then(() => this.storage.put(task));
    this.writes = write;
    return write;
  }
  activate(actor?: string) {
    if (this.actor === actor) return this.loading;
    this.actor = actor;
    this.recoveryError = undefined;
    this.publish();
    this.loading = (async () => {
      if (!actor) return;
      try {
        await this.writes.catch(() => {});
        const saved = await this.storage.list(actor);
        if (this.actor !== actor) return;
        for (const task of saved) {
          if (this.active.has(task.id)) continue;
          this.tasks.set(task.id, {
            ...task,
            status: ['saving', 'queued', 'uploading'].includes(task.status)
              ? 'uncertain'
              : task.status,
          });
        }
        this.publish();
        // Reconcile deliveries after reload; don't automatically retransmit unknown files.
        for (const task of this.list()) if (task.status === 'uncertain') void this.check(task.id);
      } catch {
        this.recoveryError =
          'Import recovery is unavailable. Keep this tab open until files are saved.';
        this.publish();
      }
    })();
    return this.loading;
  }
  async enqueue(files: File[], destination: Omit<ImportIntent, 'key'>) {
    const actor = this.actor;
    await this.loading;
    if (!actor || this.actor !== actor) return;
    let reserved = this.list().reduce((total, task) => total + (task.blob?.size ?? 0), 0);
    const batch: ImportTask[] = files.map((file, index) => {
      const key = crypto.randomUUID();
      const error = !supportedFile(file)
        ? 'Unsupported file type'
        : !file.size || file.size > this.maxBytes
          ? `File must be nonempty and at most ${Math.floor(this.maxBytes / 1024 / 1024)} MB`
          : reserved + file.size > 50 * 1024 * 1024
            ? 'Pending imports exceed 50 MB. Finish or dismiss imports first.'
            : undefined;
      if (!error) reserved += file.size;
      const task: ImportTask = {
        id: `${actor}:${key}`,
        actor,
        filename: file.name || 'Pasted image',
        mime: file.type,
        intent: {
          ...destination,
          key,
          geometry: {
            ...destination.geometry,
            x: Math.min(999000, destination.geometry.x + (index % 3) * 350),
            y: Math.min(999000, destination.geometry.y + Math.floor(index / 3) * 330),
          },
        },
        blob: error ? undefined : file,
        status: error ? 'rejected' : 'saving',
        error,
      };
      this.tasks.set(task.id, task);
      return task;
    });
    this.publish();
    await Promise.all(
      batch.map(async (task) => {
        if (task.status === 'rejected') return;
        try {
          const queued: ImportTask = { ...task, status: 'queued' };
          await this.persist(queued);
          this.tasks.set(task.id, queued);
        } catch {
          this.tasks.set(task.id, {
            ...task,
            status: 'failed',
            error: 'Could not preserve this file locally. Free browser storage and retry.',
          });
        }
      }),
    );
    this.publish();
    this.pump();
  }
  private pump() {
    for (const task of this.list()) {
      if (this.active.size >= 2) break;
      if (task.status === 'queued' && !this.active.has(task.id)) void this.send(task);
    }
  }
  private async send(task: ImportTask) {
    if (task.actor !== this.actor) return;
    this.active.add(task.id);
    this.tasks.set(task.id, { ...task, status: 'uploading', error: undefined });
    this.publish();
    try {
      const result = await this.transport.send(task);
      await this.complete(task, result);
    } catch (error) {
      const known = error instanceof ApiError && error.status >= 400 && error.status < 500;
      const next: ImportTask = {
        ...task,
        status: known ? 'failed' : 'uncertain',
        error: known
          ? (error as Error).message
          : 'Delivery is uncertain. Retry checks the original import before sending again.',
      };
      await this.persist(next).catch(() => {});
      this.tasks.set(task.id, next);
    } finally {
      this.active.delete(task.id);
      this.publish();
      this.pump();
    }
  }
  private async complete(task: ImportTask, result: ImportResult) {
    const next: ImportTask = {
      ...task,
      status: 'ready',
      result,
      blob: undefined,
      error: undefined,
    };
    // Publish only after local completion is durable. A failed write retains the original key/blob.
    await this.persist(next);
    this.tasks.set(task.id, next);
  }
  private async check(id: string) {
    const task = this.tasks.get(id);
    if (!task || task.actor !== this.actor) return false;
    try {
      const status = await this.transport.status(task.intent.key);
      if (status.state === 'ready') {
        await this.complete(task, status.result);
        this.publish();
        return true;
      }
    } catch {
      /* Retry can resend the same key; a status outage cannot prove non-delivery. */
    }
    return false;
  }
  async retry(id: string) {
    const task = this.tasks.get(id);
    if (
      !task ||
      task.actor !== this.actor ||
      !['failed', 'uncertain'].includes(task.status) ||
      this.active.has(id)
    )
      return;
    if (await this.check(id)) return;
    if (task.actor !== this.actor || !task.blob) return;
    const queued: ImportTask = { ...task, status: 'queued', error: undefined };
    try {
      await this.persist(queued);
      this.tasks.set(id, queued);
      this.publish();
      this.pump();
    } catch {
      this.recoveryError = 'Could not preserve the file locally. Free browser storage and retry.';
      this.publish();
    }
  }
  async delivered(id: string) {
    const task = this.tasks.get(id);
    if (!task || task.delivered || task.actor !== this.actor) return;
    const next = { ...task, delivered: true };
    this.tasks.set(id, next);
    await this.persist(next).catch(() => {});
    this.publish();
  }
  async dismiss(id: string) {
    const task = this.tasks.get(id);
    if (
      !task ||
      task.actor !== this.actor ||
      ['saving', 'queued', 'uploading'].includes(task.status)
    )
      return;
    // Dismiss only removes the local receipt. A committed server artifact remains in its brane.
    await this.writes.catch(() => {});
    await this.storage.remove(id);
    this.tasks.delete(id);
    this.publish();
  }
}
export const imports = new Imports(indexedImportStorage(), {
  send: (task) => {
    const body = new FormData();
    body.set('file', task.blob!, task.filename);
    body.set('intent', JSON.stringify(task.intent));
    return api<ImportResult>('/imports', body);
  },
  status: (key) => api(`/imports/${key}`),
});
