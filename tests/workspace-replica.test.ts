import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDatabase, type DB } from '../server/db';
import {
  createBrane,
  createTextBlock,
  createPlacement,
  readBrane,
  uid,
  updateBlockLiveState,
  updatePlacementGeometry,
  removePlacement,
} from '../server/services/content';
import { applyWorkspaceOperation } from '../server/services/workspace-operations';
import { DomainError } from '../server/domain/access';
import { IndexedReplicaStorage } from '../src/services/replica-storage';
import { WorkspaceReplica } from '../src/services/replica';
import { ApiError, networkApi } from '../src/services/transport';
import { createClient } from '../src/services/client';
import type { WorkspaceOperation } from '../shared/workspace-commands';
let db: DB;
beforeEach(() => {
  db = openDatabase(':memory:');
});
afterEach(() => db.close());
async function fixture() {
  const actor = uid();
  db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
    actor,
    'Local',
    `${actor}@example.com`,
    0,
    0,
  );
  const brane = createBrane(db, actor, 'Local');
  const block = createTextBlock(db, actor, brane.id);
  const storeName = `replica-test-${uid()}`;
  const storage = new IndexedReplicaStorage(storeName);
  let connected = true,
    dropReceipt = false;
  let sessionActor: string | null = actor;
  const sent: WorkspaceOperation[] = [];
  const transport: typeof networkApi = async (path, raw, method, expectedActor) => {
    if (!connected) throw new TypeError('Network disconnected');
    if (path === '/auth/get-session')
      return sessionActor
        ? { user: { id: sessionActor, name: 'Local', email: `${sessionActor}@example.com` } }
        : null;
    if (expectedActor !== sessionActor) throw new ApiError(401, 'Account changed');
    if (path === '/branes') return [brane];
    if (path.startsWith('/branes/')) return readBrane(db, actor, path.split('/')[2]);
    if (path === '/sync/commands') {
      const op = raw as WorkspaceOperation;
      sent.push(structuredClone(op));
      try {
        const receipt = applyWorkspaceOperation(db, sessionActor!, op);
        if (dropReceipt) {
          dropReceipt = false;
          throw new TypeError('Lost response after commit');
        }
        return receipt;
      } catch (error) {
        if (error instanceof DomainError) throw new ApiError(error.status, error.message);
        throw error;
      }
    }
    return { ok: true };
  };
  const replica = new WorkspaceReplica(storage, transport);
  const client = createClient(replica.request);
  await client.session();
  await replica.synchronize();
  await client.branes();
  await client.workspace(brane.id);
  return {
    actor,
    brane,
    block,
    replica,
    client,
    storage,
    sent,
    transport,
    storeName,
    offline: () => {
      connected = false;
    },
    online: () => {
      connected = true;
    },
    loseReceipt: () => {
      dropReceipt = true;
    },
    session: (id: string | null) => {
      sessionActor = id;
    },
  };
}
it('persists offline creation, edits, movement and removal across a new client and replays exactly once', async () => {
  const f = await fixture();
  f.offline();
  const b = await f.client.createBrane('Offline brane');
  const created = await f.client.createText(b.id, { x: 10, y: 20, width: 320, height: 220 });
  await f.client.saveText({ blockId: created.id, text: 'Created without a server', version: 0 });
  const placement = (await f.client.workspace(b.id)).placements[0];
  await f.client.savePlacement(placement.id, {
    x: 500,
    y: 600,
    width: 400,
    height: 300,
    version: 0,
  });
  await f.client.removePlacement(f.block.placement.id);
  await f.replica.synchronize();
  const reloaded = new WorkspaceReplica(new IndexedReplicaStorage(f.storeName), f.transport);
  const client = createClient(reloaded.request);
  await client.session();
  await reloaded.synchronize();
  expect((await client.workspace(b.id)).blocks[0].content.text).toBe('Created without a server');
  expect((await client.workspace(b.id)).placements[0]).toMatchObject({
    x: 500,
    y: 600,
    version: 1,
  });
  expect((await client.workspace(f.brane.id)).placements).toHaveLength(0);
  f.online();
  await reloaded.synchronize();
  expect((await f.storage.read(f.actor)).pending).toHaveLength(0);
  expect(readBrane(db, f.actor, b.id).blocks[0].content.text).toBe('Created without a server');
  expect(readBrane(db, f.actor, b.id).placements[0]).toMatchObject({ x: 500, version: 1 });
  expect(readBrane(db, f.actor, f.brane.id).placements).toHaveLength(0);
  expect(db.prepare('SELECT count(*) n FROM workspace_operations').get()).toEqual({ n: 5 });
});
it('reuses the durable operation key when a response is lost after commit', async () => {
  const f = await fixture();
  f.loseReceipt();
  await f.client.saveText({ blockId: f.block.id, text: 'Exactly once', version: 0 });
  await f.replica.synchronize();
  expect((await f.storage.read(f.actor)).pending).toHaveLength(1);
  await f.replica.synchronize();
  expect((await f.storage.read(f.actor)).pending).toHaveLength(0);
  expect(f.sent[0].key).toBe(f.sent[1].key);
  expect(readBrane(db, f.actor, f.brane.id).blocks[0].version).toBe(1);
  expect(() =>
    applyWorkspaceOperation(db, f.actor, {
      ...f.sent[0],
      command: { type: 'text.edit', blockId: f.block.id, text: 'Changed', version: 1 },
    }),
  ).toThrow('different content');
});
it('pauses on conflicts and explicitly rebases all later edits to the same item', async () => {
  const f = await fixture();
  f.offline();
  await f.client.saveText({ blockId: f.block.id, text: 'First local', version: 0 });
  await f.client.saveText({ blockId: f.block.id, text: 'Newest local', version: 1 });
  await f.replica.synchronize();
  updateBlockLiveState(db, f.actor, { blockId: f.block.id, text: 'Other writer', version: 0 });
  f.online();
  await f.replica.synchronize();
  expect(f.replica.getSnapshot().conflict?.failure?.status).toBe(409);
  expect((await f.client.workspace(f.brane.id)).blocks[0].content.text).toBe('Newest local');
  expect(readBrane(db, f.actor, f.brane.id).blocks[0].content.text).toBe('Other writer');
  await f.replica.resolveConflict('local');
  expect(readBrane(db, f.actor, f.brane.id).blocks[0]).toMatchObject({
    version: 3,
    content: { text: 'Newest local' },
  });
  expect((await f.storage.read(f.actor)).pending).toHaveLength(0);
});
it('preserves unrelated local work when server geometry wins a conflict', async () => {
  const f = await fixture();
  f.offline();
  await f.client.savePlacement(f.block.placement.id, {
    x: 400,
    y: 400,
    width: 320,
    height: 220,
    version: 0,
  });
  await f.client.saveText({ blockId: f.block.id, text: 'Retain this edit', version: 0 });
  await f.replica.synchronize();
  updatePlacementGeometry(db, f.actor, f.block.placement.id, {
    x: 900,
    y: 100,
    width: 320,
    height: 220,
    version: 0,
  });
  f.online();
  await f.replica.synchronize();
  await f.replica.resolveConflict('server');
  const state = readBrane(db, f.actor, f.brane.id);
  expect(state.placements[0].x).toBe(900);
  expect(state.blocks[0].content.text).toBe('Retain this edit');
});
it('serializes concurrent tabs and never replays under a different account', async () => {
  const f = await fixture();
  f.offline();
  const second = new WorkspaceReplica(new IndexedReplicaStorage(f.storeName), f.transport);
  await second.request('/auth/get-session');
  const results = await Promise.allSettled([
    f.client.saveText({ blockId: f.block.id, text: 'Tab one', version: 0 }),
    createClient(second.request).saveText({ blockId: f.block.id, text: 'Tab two', version: 0 }),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect((await f.storage.read(f.actor)).pending).toHaveLength(1);
  await f.replica.synchronize();
  await second.synchronize();
  f.session(uid());
  f.online();
  await f.replica.synchronize();
  expect(f.replica.actor).toBeUndefined();
  expect((await f.storage.read(f.actor)).pending).toHaveLength(1);
  expect(readBrane(db, f.actor, f.brane.id).blocks[0].content.text).toBe('');
});
it('does not transmit a mutation when the local transaction fails', async () => {
  const f = await fixture();
  const replica = new WorkspaceReplica(
    {
      read: f.storage.read.bind(f.storage),
      session: f.storage.session.bind(f.storage),
      change: async () => {
        throw new Error('Quota exhausted');
      },
    },
    f.transport,
  );
  await replica.request('/auth/get-session');
  await replica.synchronize();
  await expect(
    createClient(replica.request).saveText({
      blockId: f.block.id,
      text: 'Preserve draft',
      version: 0,
    }),
  ).rejects.toThrow('Quota exhausted');
  expect(f.sent).toHaveLength(0);
});

it('an older response in another window cannot resurrect a removed placement', async () => {
  const f = await fixture();
  const old = readBrane(db, f.actor, f.brane.id);
  let captured = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delayed = new WorkspaceReplica(
    new IndexedReplicaStorage(f.storeName),
    async (path, body, method, actor) => {
      if (path === `/branes/${f.brane.id}`) {
        captured = true;
        await gate;
        return old;
      }
      return f.transport(path, body, method, actor);
    },
  );
  await delayed.request('/auth/get-session');
  await delayed.synchronize();
  const olderRead = createClient(delayed.request).workspace(f.brane.id);
  await expect.poll(() => captured).toBe(true);
  removePlacement(db, f.actor, f.block.placement.id);
  expect((await f.client.workspace(f.brane.id)).placements).toHaveLength(0);
  release();
  expect((await olderRead).placements).toHaveLength(0);
  expect((await f.storage.read(f.actor)).workspaces[f.brane.id].placements).toHaveLength(0);
});

it('still caches a valid overlapping response when the newer request fails', async () => {
  const f = await fixture();
  const brane = createBrane(db, f.actor, 'Not cached yet');
  const snapshot = readBrane(db, f.actor, brane.id);
  let captured = false,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delayed = new WorkspaceReplica(
    new IndexedReplicaStorage(f.storeName),
    async (path, body, method, actor) => {
      if (path === `/branes/${brane.id}`) {
        captured = true;
        await gate;
        return snapshot;
      }
      return f.transport(path, body, method, actor);
    },
  );
  await delayed.request('/auth/get-session');
  await delayed.synchronize();
  const older = createClient(delayed.request).workspace(brane.id);
  await expect.poll(() => captured).toBe(true);
  f.offline();
  await expect(f.client.workspace(brane.id)).rejects.toThrow('not available on this device');
  release();
  await older;
  expect((await f.storage.read(f.actor)).workspaces[brane.id].brane.title).toBe('Not cached yet');
});

it('upgrades local read metadata without losing an older outbox or cached account', async () => {
  const name = `replica-upgrade-${uid()}`,
    actor = uid();
  const operation: WorkspaceOperation = {
    key: uid(),
    command: { type: 'brane.create', id: uid(), title: 'Preserve me' },
  };
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('replicas');
      request.result.createObjectStore('session');
      request.result.createObjectStore('assets');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['replicas', 'session'], 'readwrite');
    tx.objectStore('replicas').put(
      { sequence: 1, branes: [], workspaces: {}, reads: {}, pending: [operation] },
      actor,
    );
    tx.objectStore('session').put(
      { user: { id: actor, name: 'Owner', email: 'owner@example.com' } },
      'current',
    );
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  const storage = new IndexedReplicaStorage(name);
  expect((await storage.read(actor)).pending).toEqual([operation]);
  expect((await storage.read(actor)).fetches).toEqual({});
  expect((await storage.session())?.user.id).toBe(actor);
});

it('keeps one text version across branes that place the same artifact', async () => {
  const f = await fixture();
  const second = createBrane(db, f.actor, 'Second view');
  createPlacement(db, f.actor, second.id, f.block.id);
  await f.client.workspace(second.id);
  updateBlockLiveState(db, f.actor, { blockId: f.block.id, text: 'Changed elsewhere', version: 0 });
  await f.client.workspace(second.id);
  f.offline();
  expect((await f.client.workspace(f.brane.id)).blocks[0]).toMatchObject({
    version: 1,
    content: { text: 'Changed elsewhere' },
  });
  await f.client.saveText({ blockId: f.block.id, version: 1, text: 'Shared offline change' });
  expect((await f.client.workspace(second.id)).blocks[0]).toMatchObject({
    version: 2,
    content: { text: 'Shared offline change' },
  });
  await f.replica.synchronize();
  f.online();
  await f.replica.synchronize();
  expect(readBrane(db, f.actor, f.brane.id).blocks[0]).toMatchObject({
    version: 2,
    content: { text: 'Shared offline change' },
  });
});

it('dispatches independent writes and Spawn while an unrelated write is still in flight', async () => {
  const f = await fixture();
  const b = createTextBlock(db, f.actor, f.brane.id);
  await f.client.workspace(f.brane.id);
  f.offline();
  await f.client.saveText({ blockId: f.block.id, text: 'Slow A', version: 0 });
  await f.client.saveText({ blockId: b.id, text: 'Required B', version: 0 });
  await f.replica.synchronize();
  let release!: () => void,
    started = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const online: string[] = [];
  f.online();
  const replica = new WorkspaceReplica(f.storage, async (path, body, method, actor) => {
    if (
      path === '/sync/commands' &&
      (body as WorkspaceOperation).command.type === 'text.edit' &&
      (body as any).command.blockId === f.block.id
    ) {
      started = true;
      await gate;
    }
    if (path === '/artifacts/spawn' || path.endsWith('/cancel')) online.push(path);
    return f.transport(path, body, method, actor);
  });
  await replica.request('/auth/get-session');
  await expect.poll(() => started).toBe(true);
  try {
    await replica.request('/artifacts/spawn', {
      braneId: f.brane.id,
      sourceBlockIds: [b.id],
      anchorPlacementId: b.placement.id,
    });
    await replica.request('/runs/existing/cancel', {});
    expect(online).toEqual(['/artifacts/spawn', '/runs/existing/cancel']);
    expect(
      readBrane(db, f.actor, f.brane.id).blocks.find((block) => block.id === b.id)?.content.text,
    ).toBe('Required B');
    expect((await f.storage.read(f.actor)).pending).toHaveLength(1);
  } finally {
    release();
    await replica.synchronize();
  }
});

it('blocks only conflicted dependencies and refreshes server content around pending local edits', async () => {
  const f = await fixture();
  const b = createTextBlock(db, f.actor, f.brane.id);
  await f.client.workspace(f.brane.id);
  f.offline();
  await f.client.saveText({ blockId: f.block.id, text: 'Local A', version: 0 });
  await f.client.saveText({ blockId: b.id, text: 'Independent B', version: 0 });
  await f.replica.synchronize();
  updateBlockLiveState(db, f.actor, { blockId: f.block.id, text: 'Remote A', version: 0 });
  f.online();
  await f.replica.synchronize();
  expect(f.replica.getSnapshot().conflict?.command).toMatchObject({ blockId: f.block.id });
  expect((await f.storage.read(f.actor)).pending).toHaveLength(1);
  expect(
    readBrane(db, f.actor, f.brane.id).blocks.find((block) => block.id === b.id)?.content.text,
  ).toBe('Independent B');
  await f.replica.request('/artifacts/spawn', { braneId: f.brane.id, sourceBlockIds: [b.id] });
  await expect(
    f.replica.request('/artifacts/spawn', { braneId: f.brane.id, sourceBlockIds: [f.block.id] }),
  ).rejects.toThrow('sources');
  const output = createTextBlock(db, f.actor, f.brane.id);
  await expect
    .poll(async () =>
      (await f.client.workspace(f.brane.id)).blocks.some((block) => block.id === output.id),
    )
    .toBe(true);
  expect(
    (await f.client.workspace(f.brane.id)).blocks.find((block) => block.id === f.block.id)?.content
      .text,
  ).toBe('Local A');
  await f.replica.resolveConflict('server');
  expect(
    (await f.client.workspace(f.brane.id)).blocks.find((block) => block.id === f.block.id)?.content
      .text,
  ).toBe('Remote A');
});

it('cancellation bypasses local storage failures and synchronization', async () => {
  const f = await fixture();
  const fail = async (): Promise<never> => {
    throw new Error('Local storage unavailable');
  };
  const replica = new WorkspaceReplica({ read: fail, change: fail, session: fail }, f.transport);
  replica.actor = f.actor;
  await expect(replica.request('/runs/existing/cancel', {})).resolves.toEqual({ ok: true });
});

it('coordinates concurrent replay across clients without duplicate transmissions', async () => {
  const f = await fixture();
  f.offline();
  await f.client.saveText({ blockId: f.block.id, text: 'First', version: 0 });
  await f.client.saveText({ blockId: f.block.id, text: 'Second', version: 1 });
  await f.replica.synchronize();
  const second = new WorkspaceReplica(new IndexedReplicaStorage(f.storeName), f.transport);
  await second.request('/auth/get-session');
  await second.synchronize();
  f.online();
  await Promise.all([f.replica.synchronize(), second.synchronize()]);
  expect(f.sent).toHaveLength(2);
  expect(readBrane(db, f.actor, f.brane.id).blocks[0].content.text).toBe('Second');
});
