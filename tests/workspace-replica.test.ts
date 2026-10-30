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
import { readCard } from '../server/services/card-library';
import { DomainError } from '../server/domain/access';
import { IndexedReplicaStorage } from '../src/services/replica-storage';
import { WorkspaceReplica } from '../src/services/replica';
import { installWorkspace, projectCommand } from '../src/services/replica-projection';
import { ApiError, networkApi } from '../src/services/transport';
import { createClient } from '../src/services/client';
import type { WorkspaceOperation } from '../shared/workspace-commands';
let db: DB;
const firstConflict = (replica: WorkspaceReplica) => replica.getSnapshot().conflicts[0].key;
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
  const refusals: ApiError[] = [];
  let sessionActor: string | null = actor;
  let sessionLibrary: string | null = actor;
  const sent: WorkspaceOperation[] = [];
  const transport: typeof networkApi = async (
    path,
    raw,
    method,
    expectedActor,
    expectedPrincipal,
  ) => {
    if (!connected) throw new TypeError('Network disconnected');
    if (path === '/session')
      return sessionActor
        ? {
            user: { id: sessionActor, name: 'Local', email: `${sessionActor}@example.com` },
            libraryId: sessionLibrary,
            libraries: [{ id: sessionLibrary, kind: 'personal', createdAt: 0, branes: 1 }],
          }
        : null;
    if (
      expectedActor !== sessionLibrary ||
      (expectedPrincipal && expectedPrincipal !== sessionActor)
    )
      throw new ApiError(401, 'Account changed');
    if (path === '/branes') return [brane];
    if (path.startsWith('/branes/')) return readBrane(db, actor, path.split('/')[2]);
    if (path.startsWith('/blocks/')) return readCard(db, actor, path.split('/')[2]);
    if (path === '/sync/commands') {
      const op = raw as WorkspaceOperation;
      sent.push(structuredClone(op));
      const refused = refusals.shift();
      if (refused) throw refused;
      try {
        const receipt = applyWorkspaceOperation(db, sessionLibrary!, op);
        if (dropReceipt) {
          dropReceipt = false;
          throw new TypeError('Lost response after commit');
        }
        return receipt;
      } catch (error) {
        if (error instanceof DomainError)
          throw new ApiError(error.status, error.message, error.code);
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
    refuse: (error: ApiError) => {
      refusals.push(error);
    },
    session: (id: string | null) => {
      sessionActor = id;
      sessionLibrary = id;
    },
    claim: (id: string) => {
      sessionActor = id;
    },
  };
}
it('restores an unplaced card after reload and retains one placement through a lost acknowledgement', async () => {
  const f = await fixture();
  updateBlockLiveState(db, f.actor, {
    blockId: f.block.id,
    text: 'Recovered original',
    version: 0,
  });
  removePlacement(db, f.actor, f.block.placement.id);
  await f.client.workspace(f.brane.id);
  const reloaded = new WorkspaceReplica(new IndexedReplicaStorage(f.storeName), f.transport);
  const client = createClient(reloaded.request);
  await client.session();
  expect((await client.workspace(f.brane.id)).blocks).toEqual([]);
  f.loseReceipt();
  const placement = await client.createPlacement(f.brane.id, f.block.id, {
    x: 10,
    y: 20,
    width: 320,
    height: 220,
  });
  await reloaded.synchronize();
  await reloaded.synchronize();
  const saved = readBrane(db, f.actor, f.brane.id);
  expect(saved.placements.map((p) => p.id)).toEqual([placement.id]);
  expect(saved.blocks).toMatchObject([{ id: f.block.id, content: { text: 'Recovered original' } }]);
  expect((await f.storage.read(f.actor)).pending).toEqual([]);
  const delivered = f.sent.filter((op) => op.command.type === 'placement.create');
  expect(delivered).toHaveLength(2);
  expect(delivered[0].key).toBe(delivered[1].key);
});
it('keeps a fresh card preview through offline restoration, reload and a lost acknowledgement', async () => {
  const f = await fixture();
  updateBlockLiveState(db, f.actor, { blockId: f.block.id, text: 'Old text', version: 0 });
  await f.client.workspace(f.brane.id);
  await f.client.removePlacement(f.block.placement.id);
  await f.replica.synchronize();
  updateBlockLiveState(db, f.actor, { blockId: f.block.id, text: 'Fresh preview', version: 1 });
  expect(await f.client.block(f.block.id)).toMatchObject({
    version: 2,
    content: { text: 'Fresh preview' },
  });
  f.offline();
  const placement = await f.client.createPlacement(f.brane.id, f.block.id, {
    x: 10,
    y: 20,
    width: 320,
    height: 220,
  });
  await f.replica.synchronize();
  const reloaded = new WorkspaceReplica(new IndexedReplicaStorage(f.storeName), f.transport);
  const client = createClient(reloaded.request);
  await client.session();
  expect((await client.workspace(f.brane.id)).blocks).toMatchObject([
    { id: f.block.id, version: 2, content: { text: 'Fresh preview' } },
  ]);
  f.online();
  f.loseReceipt();
  await reloaded.synchronize();
  await reloaded.synchronize();
  expect(readBrane(db, f.actor, f.brane.id).placements.map((p) => p.id)).toEqual([placement.id]);
  expect((await client.workspace(f.brane.id)).blocks[0].content.text).toBe('Fresh preview');
  const sent = f.sent.filter((op) => op.command.type === 'placement.create');
  expect(sent).toHaveLength(2);
  expect(sent[0].key).toBe(sent[1].key);
});

it('uses the same cached card for preview and restoration when a read is superseded by a local operation', async () => {
  const f = await fixture();
  updateBlockLiveState(db, f.actor, { blockId: f.block.id, text: 'Cached card', version: 0 });
  await f.client.workspace(f.brane.id);
  await f.client.removePlacement(f.block.placement.id);
  await f.replica.synchronize();
  updateBlockLiveState(db, f.actor, { blockId: f.block.id, text: 'New server card', version: 1 });
  let captured = false,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delayed = new WorkspaceReplica(new IndexedReplicaStorage(f.storeName), async (...args) => {
    const value = await f.transport(...args);
    if (args[0] === `/blocks/${f.block.id}`) {
      captured = true;
      await gate;
    }
    return value;
  });
  const client = createClient(delayed.request);
  await client.session();
  await delayed.synchronize();
  const preview = client.block(f.block.id);
  await expect.poll(() => captured).toBe(true);
  f.offline();
  await f.client.saveTitle(f.brane.id, 'Offline title');
  await f.replica.synchronize();
  release();
  const shown = await preview;
  await client.createPlacement(f.brane.id, f.block.id, {
    x: 10,
    y: 20,
    width: 320,
    height: 220,
  });
  const restored = (await client.workspace(f.brane.id)).blocks[0];
  expect(restored).toEqual(shown);
  expect(shown).toMatchObject({ version: 1, content: { text: 'Cached card' } });
  await delayed.synchronize();
});

it('preserves pending text against newer card reads until explicit conflict resolution', async () => {
  const f = await fixture();
  await f.client.block(f.block.id);
  f.offline();
  await f.client.saveText({ blockId: f.block.id, text: 'Keep my local intent', version: 0 });
  await f.replica.synchronize();
  const original = (await f.storage.read(f.actor)).pending[0];
  updateBlockLiveState(db, f.actor, { blockId: f.block.id, text: 'Remote one', version: 0 });
  updateBlockLiveState(db, f.actor, { blockId: f.block.id, text: 'Remote two', version: 1 });
  f.online();
  await f.replica.synchronize();
  const path = `/blocks/${f.block.id}`;
  await f.client.block(f.block.id);
  await expect.poll(async () => (await f.storage.read(f.actor)).fetches[path].received).toBe(2);
  expect((await f.storage.read(f.actor)).reads[path]).toMatchObject({
    version: 1,
    content: { text: 'Keep my local intent' },
  });
  expect((await f.storage.read(f.actor)).pending[0]).toMatchObject({
    key: original.key,
    command: original.command,
    failure: { status: 409 },
  });
  expect((await f.client.workspace(f.brane.id)).blocks[0].content.text).toBe(
    'Keep my local intent',
  );
  await f.replica.resolveConflict(firstConflict(f.replica), 'server');
  expect(await f.client.block(f.block.id)).toMatchObject({
    version: 2,
    content: { text: 'Remote two' },
  });
  f.offline();
  await f.client.removePlacement(f.block.placement.id);
  await f.client.createPlacement(f.brane.id, f.block.id, {
    x: 10,
    y: 20,
    width: 320,
    height: 220,
  });
  expect((await f.client.workspace(f.brane.id)).blocks[0].content.text).toBe('Remote two');
  await f.replica.synchronize();
});

it('reconciles detached cards into existing placements without losing order or finalized version-zero output', async () => {
  const f = await fixture();
  await f.storage.change(f.actor, (state) => {
    const workspace = state.workspaces[f.brane.id];
    const final = {
      ...workspace.blocks[0],
      origin: 'generated' as const,
      messageId: uid(),
      content: { format: 'text' as const, text: 'Final answer' },
    };
    const second = { ...workspace.blocks[0], id: uid() };
    workspace.blocks = [
      { ...final, messageId: undefined, content: { format: 'text', text: '' } },
      second,
    ];
    state.reads[`/blocks/${final.id}`] = final;
    projectCommand(state, {
      type: 'placement.create',
      id: uid(),
      braneId: f.brane.id,
      blockId: final.id,
      geometry: { x: 10, y: 20, width: 320, height: 220 },
    });
    expect(workspace.blocks.map((block) => block.id)).toEqual([final.id, second.id]);
    expect(workspace.blocks[0]).toEqual(final);
    const incoming = structuredClone(workspace);
    incoming.blocks[0] = { ...final, messageId: undefined, content: { format: 'text', text: '' } };
    installWorkspace(state, incoming);
    expect(state.workspaces[f.brane.id].blocks[0]).toEqual(final);
    expect(state.reads[`/blocks/${final.id}`]).toEqual(final);
  });
});
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
  expect(f.replica.getSnapshot().conflicts[0]?.failure?.status).toBe(409);
  expect((await f.client.workspace(f.brane.id)).blocks[0].content.text).toBe('Newest local');
  expect(readBrane(db, f.actor, f.brane.id).blocks[0].content.text).toBe('Other writer');
  await f.replica.resolveConflict(firstConflict(f.replica), 'local');
  expect(readBrane(db, f.actor, f.brane.id).blocks[0]).toMatchObject({
    version: 3,
    content: { text: 'Newest local' },
  });
  expect((await f.storage.read(f.actor)).pending).toHaveLength(0);
});
it('keeps a retryable refusal queued but pauses a guest limit for review', async () => {
  const f = await fixture();
  f.refuse(new ApiError(429, 'Too many requests; try again shortly', 'rate_limited'));
  await f.client.saveText({ blockId: f.block.id, text: 'Later', version: 0 });
  await f.replica.synchronize();
  const queued = (await f.storage.read(f.actor)).pending;
  expect(queued).toHaveLength(1);
  expect(queued[0].failure).toBeUndefined();
  expect(f.replica.getSnapshot().conflicts).toEqual([]);
  await f.replica.synchronize();
  expect((await f.storage.read(f.actor)).pending).toHaveLength(0);
  f.refuse(new ApiError(429, 'Guest workspace limit reached.', 'guest_limit'));
  await f.client.saveText({ blockId: f.block.id, text: 'Over the limit', version: 1 });
  await f.replica.synchronize();
  expect(f.replica.getSnapshot().conflicts[0]?.failure).toMatchObject({
    status: 429,
    message: 'Guest workspace limit reached.',
  });
});
it('reviews the final local text and keeps it as a copy when the server wins', async () => {
  const f = await fixture();
  f.offline();
  await f.client.saveText({ blockId: f.block.id, text: 'Hel', version: 0 });
  await f.client.saveText({ blockId: f.block.id, text: 'Hello, a whole paragraph', version: 1 });
  await f.replica.synchronize();
  updateBlockLiveState(db, f.actor, { blockId: f.block.id, text: 'Other writer', version: 0 });
  f.online();
  await f.replica.synchronize();
  const review = await f.replica.inspectConflict(firstConflict(f.replica));
  expect(review?.local).toMatchObject({ content: { text: 'Hello, a whole paragraph' } });
  expect(review?.server).toMatchObject({ content: { text: 'Other writer' } });
  await f.replica.resolveConflict(review!.key, 'server');
  expect((await f.storage.read(f.actor)).pending).toHaveLength(0);
  const texts = readBrane(db, f.actor, f.brane.id).blocks.map((b) => b.content.text);
  expect(texts.sort()).toEqual(['Hello, a whole paragraph', 'Other writer']);
  const copy = readBrane(db, f.actor, f.brane.id).placements.find(
    (p) => p.id !== f.block.placement.id,
  );
  expect(copy).toMatchObject({ x: f.block.placement.x + 32, y: f.block.placement.y + 32 });
});
it('resolves each conflict even when another queued target was removed on the server', async () => {
  const f = await fixture();
  const other = createTextBlock(db, f.actor, f.brane.id);
  await f.client.workspace(f.brane.id);
  f.offline();
  await f.client.saveText({ blockId: f.block.id, text: 'Local text', version: 0 });
  await f.client.savePlacement(other.placement.id, {
    x: 700,
    y: 700,
    width: 320,
    height: 220,
    version: 0,
  });
  await f.replica.synchronize();
  updateBlockLiveState(db, f.actor, { blockId: f.block.id, text: 'Remote text', version: 0 });
  removePlacement(db, f.actor, other.placement.id);
  f.online();
  await f.replica.synchronize();
  const conflicts = f.replica.getSnapshot().conflicts;
  expect(conflicts.map((c) => c.command.type).sort()).toEqual(['placement.edit', 'text.edit']);
  const text = conflicts.find((c) => c.command.type === 'text.edit')!;
  await f.replica.resolveConflict(text.key, 'local');
  expect(readBrane(db, f.actor, f.brane.id).blocks.find((b) => b.id === f.block.id)).toMatchObject({
    content: { text: 'Local text' },
  });
  const [moved] = f.replica.getSnapshot().conflicts;
  expect(moved.command.type).toBe('placement.edit');
  await f.replica.resolveConflict(moved.key, 'server');
  expect((await f.storage.read(f.actor)).pending).toHaveLength(0);
  expect(f.replica.getSnapshot().conflicts).toEqual([]);
});
it('treats a removal that the server already made as satisfied', async () => {
  const f = await fixture();
  f.offline();
  await f.client.removePlacement(f.block.placement.id);
  await f.replica.synchronize();
  removePlacement(db, f.actor, f.block.placement.id);
  f.online();
  await f.replica.synchronize();
  expect(f.replica.getSnapshot().conflicts).toHaveLength(1);
  await f.replica.resolveConflict(firstConflict(f.replica), 'local');
  expect((await f.storage.read(f.actor)).pending).toHaveLength(0);
});
it('discards a refused creation together with the changes that depend on it', async () => {
  const f = await fixture();
  f.offline();
  const created = await f.client.createText(f.brane.id, { x: 0, y: 0, width: 320, height: 220 });
  await f.client.saveText({ blockId: created.id, text: 'Depends on creation', version: 0 });
  await f.client.saveText({ blockId: f.block.id, text: 'Unrelated', version: 0 });
  await f.replica.synchronize();
  f.refuse(new ApiError(429, 'Guest workspace limit reached.', 'guest_limit'));
  f.online();
  await f.replica.synchronize();
  const [refused] = f.replica.getSnapshot().conflicts;
  expect(refused.command.type).toBe('block.create');
  await expect(f.replica.resolveConflict(refused.key, 'local')).rejects.toThrow('Discard it');
  await f.replica.resolveConflict(refused.key, 'server');
  expect((await f.storage.read(f.actor)).pending).toHaveLength(0);
  const state = readBrane(db, f.actor, f.brane.id);
  expect(state.blocks.map((b) => b.id)).toEqual([f.block.id]);
  expect(state.blocks[0].content.text).toBe('Unrelated');
  expect((await f.client.workspace(f.brane.id)).blocks.map((b) => b.id)).toEqual([f.block.id]);
});
it('takes the text versions a Run saved, so the next local edit is not refused', async () => {
  const f = await fixture();
  const replica = new WorkspaceReplica(
    new IndexedReplicaStorage(f.storeName),
    async (path, raw, method, ...rest) => {
      if (path !== '/runs') return f.transport(path, raw, method, ...rest);
      // The server saves the source text as part of accepting the Run.
      const saved = updateBlockLiveState(db, f.actor, {
        blockId: f.block.id,
        text: 'Sent with the run',
        version: 0,
      });
      return {
        runId: uid(),
        outputBlockId: uid(),
        edits: [{ blockId: f.block.id, version: saved.version, content: saved.content }],
      };
    },
  );
  const client = createClient(replica.request);
  await client.session();
  await client.workspace(f.brane.id);
  await replica.request('/runs', { braneId: f.brane.id, references: [f.block.id] });
  // The connection drops before any refresh can bring the new version.
  f.offline();
  expect((await client.workspace(f.brane.id)).blocks[0]).toMatchObject({
    version: 1,
    content: { text: 'Sent with the run' },
  });
  await client.saveText({ blockId: f.block.id, text: 'Edited after the run', version: 1 });
  f.online();
  await replica.synchronize();
  expect((await f.storage.read(f.actor)).pending).toHaveLength(0);
  expect(readBrane(db, f.actor, f.brane.id).blocks[0]).toMatchObject({
    version: 2,
    content: { text: 'Edited after the run' },
  });
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
  await f.replica.resolveConflict(firstConflict(f.replica), 'server');
  const state = readBrane(db, f.actor, f.brane.id);
  expect(state.placements[0].x).toBe(900);
  expect(state.blocks[0].content.text).toBe('Retain this edit');
});
it('serializes concurrent tabs and never replays under a different account', async () => {
  const f = await fixture();
  f.offline();
  const second = new WorkspaceReplica(new IndexedReplicaStorage(f.storeName), f.transport);
  await second.request('/session');
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
  await replica.request('/session');
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
  await delayed.request('/session');
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
  await delayed.request('/session');
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
      {
        user: { id: actor, name: 'Owner', email: 'owner@example.com' },
        libraryId: actor,
        libraries: [{ id: actor, kind: 'personal', createdAt: 0, branes: 1 }],
      },
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
  await replica.request('/session');
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
  expect(f.replica.getSnapshot().conflicts[0]?.command).toMatchObject({ blockId: f.block.id });
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
  await f.replica.resolveConflict(firstConflict(f.replica), 'server');
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
  await second.request('/session');
  await second.synchronize();
  f.online();
  await Promise.all([f.replica.synchronize(), second.synchronize()]);
  expect(f.sent).toHaveLength(2);
  expect(readBrane(db, f.actor, f.brane.id).blocks[0].content.text).toBe('Second');
});

it('keeps two tabs and their pending operation identities on the same library after account claiming', async () => {
  const f = await fixture();
  const second = new WorkspaceReplica(new IndexedReplicaStorage(f.storeName), f.transport);
  await second.request('/session');
  f.offline();
  await f.client.saveText({ blockId: f.block.id, version: 0, text: 'Before signing in' });
  const pending = (await f.storage.read(f.actor)).pending;
  const principal = uid();
  f.claim(principal);
  f.online();
  await f.client.session();
  await second.request('/session');
  await Promise.all([f.replica.synchronize(), second.synchronize()]);
  expect(f.replica.actor).toBe(f.actor);
  expect(second.actor).toBe(f.actor);
  expect(f.replica.principal).toBe(principal);
  expect(second.principal).toBe(principal);
  expect((await f.storage.read(f.actor)).pending).toHaveLength(0);
  expect(readBrane(db, f.actor, f.brane.id).blocks[0]).toMatchObject({
    version: 1,
    content: { text: 'Before signing in' },
  });
  expect(db.prepare('SELECT operation_key FROM workspace_operations').all()).toEqual([
    { operation_key: pending[0].key },
  ]);
});
it('puts a card from a back on the table offline and removes a back with its host', async () => {
  const f = await fixture();
  const host = readBrane(db, f.actor, f.brane.id).placements[0];
  const first = createTextBlock(db, f.actor, f.brane.id);
  const second = createTextBlock(db, f.actor, f.brane.id);
  const held = [first, second].map(
    (block) =>
      createPlacement(db, f.actor, f.brane.id, block.id, undefined, uid(), host.id) as {
        id: string;
        version: number;
      },
  );
  await f.client.workspace(f.brane.id);
  f.offline();
  const geometry = { x: 700, y: 40, width: 320, height: 220 };
  await f.client.detachPlacement(held[0].id, held[0].version, geometry);
  await f.client.removePlacement(host.id);
  const local = await f.client.workspace(f.brane.id);
  expect(local.placements.find((p) => p.id === held[0].id)).toMatchObject({
    ...geometry,
    host_placement_id: null,
  });
  expect(local.placements.map((p) => p.id)).not.toContain(held[1].id);
  f.online();
  await f.replica.synchronize();
  const server = readBrane(db, f.actor, f.brane.id).placements;
  expect(server.find((p) => p.id === held[0].id)).toMatchObject({
    ...geometry,
    host_placement_id: null,
    version: held[0].version + 1,
  });
  expect(server.map((p) => p.id)).not.toContain(held[1].id);
  expect(server.map((p) => p.id)).not.toContain(host.id);
});
