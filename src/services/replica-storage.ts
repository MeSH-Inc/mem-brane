import type { Session } from '../../shared/contracts';
import type { Brane, BraneState } from '../../shared/types/domain';
import type { WorkspaceOperation } from '../../shared/workspace-commands';

export interface PendingOperation extends WorkspaceOperation {
  failure?: { status: number; message: string };
}
export interface ReplicaState {
  sequence: number;
  branes: Brane[];
  workspaces: Record<string, BraneState>;
  reads: Record<string, unknown>;
  fetches: Record<string, { issued: number; received: number }>;
  pending: PendingOperation[];
}
export const emptyReplica = (): ReplicaState => ({
  sequence: 0,
  branes: [],
  workspaces: {},
  reads: {},
  fetches: {},
  pending: [],
});
export interface ReplicaStorage {
  read(actor: string): Promise<ReplicaState>;
  change<T>(actor: string, work: (state: ReplicaState) => T): Promise<T>;
  session(value?: Session): Promise<Session>;
}
// A read/write transaction serializes read-modify-write across tabs. The outbox
// and its visible projection commit together, before any request is dispatched.
export class IndexedReplicaStorage implements ReplicaStorage {
  private database?: Promise<IDBDatabase>;
  constructor(private name = 'mem-brane-local') {}
  private open() {
    return (this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name, 3);
      request.onupgradeneeded = (event) => {
        if (event.oldVersion === 0) {
          request.result.createObjectStore('replicas');
          request.result.createObjectStore('session');
          request.result.createObjectStore('assets');
        }
        const records = request.transaction!.objectStore('replicas').openCursor();
        records.onsuccess = () => {
          const cursor = records.result;
          if (!cursor) return;
          cursor.update({ ...cursor.value, fetches: {} });
          cursor.continue();
        };
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          this.database = undefined;
        };
        resolve(request.result);
      };
      request.onerror = () => {
        this.database = undefined;
        reject(request.error);
      };
    }));
  }
  private async transaction<T>(
    store: string,
    key: string,
    update: boolean,
    work: (value: any) => { value: unknown; result: T },
  ): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, update ? 'readwrite' : 'readonly');
      const objectStore = tx.objectStore(store);
      const request = objectStore.get(key);
      let result: T;
      let error: unknown;
      request.onsuccess = () => {
        try {
          const changed = work(request.result);
          result = changed.result;
          if (update) objectStore.put(changed.value, key);
        } catch (cause) {
          error = cause;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () =>
        reject(error ?? tx.error ?? new Error('Local storage transaction failed.'));
    });
  }
  read(actor: string) {
    return this.transaction('replicas', actor, false, (value) => ({
      value,
      result: value ?? emptyReplica(),
    }));
  }
  change<T>(actor: string, work: (state: ReplicaState) => T) {
    return this.transaction('replicas', actor, true, (value) => {
      const state = value ?? emptyReplica();
      return { value: state, result: work(state) };
    });
  }
  session(value?: Session) {
    return this.transaction('session', 'current', value !== undefined, (saved) => ({
      value: value ?? null,
      result: value === undefined ? (saved ?? null) : value,
    }));
  }
  asset(actor: string, id: string, blob?: Blob): Promise<Blob | undefined> {
    return this.transaction('assets', JSON.stringify([actor, id]), !!blob, (saved) => ({
      value: blob,
      result: blob ?? saved,
    }));
  }
}
