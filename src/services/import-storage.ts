import type { ImportTask } from './imports';
export interface ImportStorage {
  list(actor: string): Promise<ImportTask[]>;
  put(task: ImportTask): Promise<void>;
  remove(key: string): Promise<void>;
}
export function indexedImportStorage(): ImportStorage {
  let database: Promise<IDBDatabase> | undefined;
  const open = () =>
    (database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('mem-brane-imports', 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore('imports', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }));
  async function tx<T>(
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('imports', mode),
        request = work(transaction.objectStore('imports'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }
  return {
    list: async (actor) =>
      (await tx('readonly', (store) => store.getAll())).filter((task) => task.actor === actor),
    put: async (task) => {
      await tx('readwrite', (store) => store.put(task));
    },
    remove: async (key) => {
      await tx('readwrite', (store) => store.delete(key));
    },
  };
}
