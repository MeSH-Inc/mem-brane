// Drafts are recoverable local edits, scoped to the authenticated actor. They never replace server state.
export interface Draft {
  key: string;
  actor: string;
  blockId: string;
  text: string;
  baseVersion: number;
  baseText: string;
  updatedAt: number;
}
export type DiscardDraftResult = 'removed' | 'missing' | 'changed';
export interface DraftStorage {
  list(actor: string): Promise<Draft[]>;
  put(draft: Draft): Promise<void>;
  remove(key: string): Promise<void>;
  removeIfUnchanged(expected: Draft): Promise<DiscardDraftResult>;
}
export function indexedDraftStorage(): DraftStorage {
  let database: Promise<IDBDatabase> | undefined;
  const open = () =>
    (database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('mem-brane-drafts', 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore('drafts', { keyPath: 'key' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }));
  async function transaction<T>(
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('drafts', mode),
        request = work(tx.objectStore('drafts'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  return {
    list: async (actor) =>
      (await transaction('readonly', (s) => s.getAll())).filter((d) => d.actor === actor),
    put: async (draft) => {
      await transaction('readwrite', (s) => s.put(draft));
    },
    remove: async (key) => {
      await transaction('readwrite', (s) => s.delete(key));
    },
    removeIfUnchanged: async (expected) => {
      const snapshot = structuredClone(expected);
      const db = await open();
      return new Promise<DiscardDraftResult>((resolve, reject) => {
        // IndexedDB serializes overlapping read/write transactions across tabs.
        // Read, compare every field and delete within this same transaction.
        const tx = db.transaction('drafts', 'readwrite');
        const store = tx.objectStore('drafts');
        const read = store.get(snapshot.key);
        let result: DiscardDraftResult = 'missing';
        read.onsuccess = () => {
          const current: Draft | undefined = read.result;
          if (!current) return;
          if (
            (Object.keys(snapshot) as (keyof Draft)[]).every(
              (field) => current[field] === snapshot[field],
            ) &&
            Object.keys(current).length === Object.keys(snapshot).length
          ) {
            store.delete(snapshot.key);
            result = 'removed';
          } else result = 'changed';
        };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    },
  };
}
export class DraftRecovery {
  private tail = Promise.resolve();
  constructor(private storage: DraftStorage) {}
  load(actor: string) {
    return this.tail.then(() => this.storage.list(actor));
  }
  save(draft: Draft) {
    this.tail = this.tail.catch(() => {}).then(() => this.storage.put(draft));
    return this.tail;
  }
  remove(key: string) {
    this.tail = this.tail.catch(() => {}).then(() => this.storage.remove(key));
    return this.tail;
  }
  discard(expected: Draft) {
    const snapshot = structuredClone(expected);
    const result = this.tail.catch(() => {}).then(() => this.storage.removeIfUnchanged(snapshot));
    // The caller receives removal failures; they must not poison later recovery reads.
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  flush() {
    return this.tail;
  }
}
export const draftKey = () => crypto.randomUUID();
export function draftDisposition(
  draft: Draft,
  current: { version: number; content: { text: string } },
) {
  return draft.text === current.content.text
    ? 'saved'
    : draft.baseVersion === current.version
      ? 'recoverable'
      : 'conflict';
}
