import { expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  Imports,
  type ImportTask,
  type ImportResult,
  type ImportTransport,
} from '../src/services/imports';
import { indexedImportStorage, type ImportStorage } from '../src/services/import-storage';
import { ApiError } from '../src/services/api';
const destination = (braneId = 'brane-a') => ({
  braneId,
  target: 'composer' as const,
  geometry: { x: 20, y: 30, width: 320, height: 300 },
});
const file = (name = 'screenshot.png') => new File(['fixture'], name, { type: 'image/png' });
const result: ImportResult = { blockId: 'block-a', placementId: 'placement-a', braneId: 'brane-a' };
function storage(): ImportStorage {
  const tasks = new Map<string, ImportTask>();
  return {
    list: async (actor) => [...tasks.values()].filter((task) => task.actor === actor),
    put: async (task) => {
      tasks.set(task.id, structuredClone(task));
    },
    remove: async (id) => {
      tasks.delete(id);
    },
  };
}
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
const missing = async () => {
  throw new ApiError(404, 'Not found');
};
it('captures destinations during navigation and isolates late completion from another actor', async () => {
  const delivery = gate<ImportResult>();
  const send = vi.fn(async () => delivery.promise);
  const imports = new Imports(storage(), { send, status: missing });
  await imports.activate('alice');
  await imports.enqueue([file()], destination());
  expect(imports.list('brane-a')[0].status).toBe('uploading');
  expect(imports.list('brane-b')).toHaveLength(0);
  await imports.activate('bob');
  delivery.resolve(result);
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(imports.list()).toHaveLength(0);
  await imports.activate('alice');
  await vi.waitFor(() => expect(imports.list('brane-a')[0].status).toBe('ready'));
  expect(imports.list()[0].intent.target).toBe('composer');
  expect(imports.list()[0].delivered).toBeUndefined();
});
it('retains supported files in a mixed batch and gives every item a distinct intended placement', async () => {
  const send = vi.fn(async () => result);
  const imports = new Imports(storage(), { send, status: missing });
  await imports.activate('alice');
  await imports.enqueue(
    [file(), new File(['data'], 'archive.zip'), file('other.png')],
    destination(),
  );
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect(imports.list().map((task) => task.intent.geometry.x)).toEqual([20, 370, 720]);
  expect(imports.list()[1]).toMatchObject({ status: 'rejected', error: 'Unsupported file type' });
});
it('lost-response retry checks the original receipt and never repeats a completed send', async () => {
  const send = vi.fn(async () => {
    throw new Error('connection lost');
  });
  const transport: ImportTransport = { send, status: async () => ({ state: 'ready', result }) };
  const imports = new Imports(storage(), transport);
  await imports.activate('alice');
  await imports.enqueue([file()], destination());
  await vi.waitFor(() => expect(imports.list()[0].status).toBe('uncertain'));
  const key = imports.list()[0].intent.key;
  await imports.retry(imports.list()[0].id);
  expect(send).toHaveBeenCalledOnce();
  expect(imports.list()[0]).toMatchObject({ status: 'ready', intent: { key }, result });
  expect(imports.list()[0].blob).toBeUndefined();
});
it('reload preserves actual blobs and retries the same key after an unfinished upload', async () => {
  const saved = indexedImportStorage();
  const actor = crypto.randomUUID();
  const first = new Imports(saved, {
    send: async () => {
      throw new Error('offline');
    },
    status: missing,
  });
  await first.activate(actor);
  await first.enqueue([file()], destination());
  await vi.waitFor(() => expect(first.list()[0].status).toBe('uncertain'));
  const key = first.list()[0].intent.key;
  const send = vi.fn(async (task: ImportTask) => {
    expect(await task.blob!.text()).toBe('fixture');
    return result;
  });
  const reloaded = new Imports(saved, { send, status: async () => ({ state: 'pending' }) });
  await reloaded.activate(actor);
  expect(reloaded.list()[0].intent.key).toBe(key);
  await reloaded.retry(reloaded.list()[0].id);
  await vi.waitFor(() => expect(reloaded.list()[0].status).toBe('ready'));
  expect(send.mock.calls[0][0].intent.key).toBe(key);
});
it('does not upload an unpreserved file when local storage fails', async () => {
  const send = vi.fn(async () => result);
  const imports = new Imports(
    {
      ...storage(),
      put: async () => {
        throw new Error('quota');
      },
    },
    { send, status: missing },
  );
  await imports.activate('alice');
  await imports.enqueue([file()], destination());
  expect(imports.list()[0].status).toBe('failed');
  expect(send).not.toHaveBeenCalled();
  expect(imports.list()[0].blob).toBeDefined();
});
