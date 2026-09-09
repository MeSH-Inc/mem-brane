import { afterEach, beforeEach, expect, it } from 'vitest';
import { Hono } from 'hono';
import { openDatabase, type DB } from '../server/db/index';
import { createAuth } from '../server/auth/index';
import { createApi } from '../server/api/index';
import { EventHub } from '../server/sse/hub';
import type { AssetStore } from '../server/storage/assets';
import {
  createBrane,
  createTextBlock,
  revisions,
  updateBlockLiveState,
  uid,
} from '../server/services/content';
let db: DB, app: Hono, actor: string, cookie: string, hub: EventHub;
const stored = new Map<string, Uint8Array>();
const memoryStore: AssetStore = {
  async put(key, bytes) {
    stored.set(key, bytes);
  },
  async get(key) {
    return stored.get(key)!;
  },
  async delete(key) {
    stored.delete(key);
  },
  async createReadUrl() {
    return '';
  },
};
beforeEach(async () => {
  stored.clear();
  db = openDatabase(':memory:');
  const auth = createAuth(db);
  const signed = await auth.api.signUpEmail({
    body: { email: `${uid()}@example.com`, password: 'valid-test-password', name: 'API Tester' },
    asResponse: true,
  });
  cookie = signed.headers
    .getSetCookie()
    .map((s) => s.split(';')[0])
    .join('; ');
  actor = (await signed.json()).user.id;
  app = new Hono();
  hub = new EventHub();
  app.route('/api', createApi(db, auth, hub, memoryStore));
});
afterEach(() => db.close());
const headers = () => ({
  'Content-Type': 'application/json',
  cookie,
  origin: 'http://localhost:5173',
});
it('requires a real Better Auth session and validates mutation origin', async () => {
  expect((await app.request('/api/branes')).status).toBe(401);
  expect((await app.request('/api/branes', { headers: headers() })).status).toBe(200);
  expect(
    (
      await app.request('/api/branes', {
        method: 'POST',
        headers: { ...headers(), origin: 'https://evil.example' },
        body: '{}',
      })
    ).status,
  ).toBe(403);
});
it('exposes brane and run domain operations with frozen context inspection', async () => {
  const braneResponse = await app.request('/api/branes', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ title: 'API brane' }),
  });
  expect(braneResponse.status).toBe(201);
  const brane = await braneResponse.json();
  const block = createTextBlock(db, actor, brane.id);
  const r = await app.request('/api/runs', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      braneId: brane.id,
      key: uid(),
      model: 'mock',
      prompt: 'Inspect this',
      references: [block.id],
      edits: [{ blockId: block.id, text: 'Frozen from API', version: 0 }],
    }),
  });
  expect(r.status).toBe(201);
  const run = await r.json();
  const inspect = await app.request(`/api/runs/${run.runId}`, { headers: headers() });
  const inspected = await inspect.json();
  expect(inspected.inputs[0].content.text).toBe('Frozen from API');
  expect(inspected.inputs[0]).not.toHaveProperty('content_json');
  const reload = await app.request(`/api/branes/${brane.id}`, { headers: headers() });
  expect((await reload.json()).runs[0].id).toBe(run.runId);
  const history = await app.request(`/api/branes/${brane.id}/runs?limit=1`, { headers: headers() });
  expect(await history.json()).toMatchObject({ items: [{ id: run.runId }], nextCursor: null });
  expect(
    (await app.request(`/api/branes/${brane.id}/runs?limit=51`, { headers: headers() })).status,
  ).toBe(400);
});
it('checks another actor’s protected resources through HTTP', async () => {
  const other = uid();
  db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
    other,
    'Other',
    `${other}@example.com`,
    Date.now(),
    Date.now(),
  );
  const b = createBrane(db, other),
    block = createTextBlock(db, other, b.id);
  expect((await app.request(`/api/branes/${b.id}`, { headers: headers() })).status).toBe(404);
  expect(
    (await app.request(`/api/blocks/${block.id}/snapshot`, { method: 'POST', headers: headers() }))
      .status,
  ).toBe(404);
  const asset = uid();
  db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?,?)').run(
    asset,
    other,
    asset,
    'image/png',
    12,
    Date.now(),
    'a'.repeat(64),
  );
  expect((await app.request(`/api/assets/${asset}`, { headers: headers() })).status).toBe(404);
});
it('validates domain inputs instead of exposing arbitrary row edits', async () => {
  const b = createBrane(db, actor);
  expect(
    (
      await app.request('/api/blocks/text', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ braneId: b.id, geometry: { x: 0, y: 0, width: -20, height: 1 } }),
      })
    ).status,
  ).toBe(400);
});

it('rate-limit hook bounds bursts and expires its window', async () => {
  const { createRateLimit } = await import('../server/api/rate-limit');
  const allow = createRateLimit(2, 100);
  expect(allow('actor', 0)).toBe(true);
  expect(allow('actor', 1)).toBe(true);
  expect(allow('actor', 2)).toBe(false);
  expect(allow('other', 2)).toBe(true);
  expect(allow('actor', 101)).toBe(true);
});

it('uploads an image, authorizes its bytes and reconstructs its brane placement', async () => {
  const brane = createBrane(db, actor);
  const bytes = await (
    await import('sharp')
  )
    .default({ create: { width: 2, height: 3, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
  const body = new FormData();
  body.append(
    'intent',
    JSON.stringify({
      key: uid(),
      braneId: brane.id,
      target: 'canvas',
      geometry: { x: 10, y: 20, width: 320, height: 300 },
    }),
  );
  body.append('file', new File([bytes], 'pixel.png', { type: 'image/png' }));
  const response = await app.request('/api/imports', {
    method: 'POST',
    headers: { cookie, origin: 'http://localhost:5173' },
    body,
  });
  expect(response.status).toBe(201);
  const receipt = await response.json();
  const state = await (
    await app.request(`/api/branes/${brane.id}`, { headers: { cookie } })
  ).json();
  const block = state.blocks.find((b: any) => b.id === receipt.blockId);
  expect(receipt).toEqual({
    blockId: block.id,
    braneId: brane.id,
    placementId: state.placements[0].id,
  });
  const image = await app.request(`/api/assets/${block.content.assetId}`, { headers: { cookie } });
  expect(image.headers.get('content-type')).toBe('image/png');
  expect(Buffer.from(await image.arrayBuffer())).toEqual(bytes);
  const reload = await app.request(`/api/branes/${brane.id}`, { headers: { cookie } });
  expect((await reload.json()).blocks[0].content.assetId).toBe(block.content.assetId);
});

it('multiplexes actor events, disconnects cleanly, and reconnects with authoritative state', async () => {
  const response = await app.request('/api/events', { headers: { cookie } }),
    reader = response.body!.getReader(),
    decoder = new TextDecoder();
  expect(decoder.decode((await reader.read()).value)).toContain('event: ready');
  hub.publish('someone-else', { type: 'run', runId: uid(), braneId: uid(), text: 'PRIVATE' });
  const runId = uid();
  hub.publish(actor, {
    type: 'run',
    runId,
    braneId: uid(),
    status: 'completed',
    text: 'Saved output',
  });
  const chunk = decoder.decode((await reader.read()).value);
  expect(chunk).toContain(runId);
  expect(chunk).not.toContain('PRIVATE');
  await reader.cancel();
  const reconnect = await app.request('/api/events', { headers: { cookie } }),
    next = reconnect.body!.getReader();
  expect(decoder.decode((await next.read()).value)).toContain('"reconcile":true');
  await next.cancel();
});
it('explicit snapshots and placement reuse/removal remain domain operations', async () => {
  const brane = createBrane(db, actor),
    other = createBrane(db, actor),
    block = createTextBlock(db, actor, brane.id);
  const snapshot = await app.request(`/api/blocks/${block.id}/snapshot`, {
    method: 'POST',
    headers: headers(),
  });
  expect(snapshot.status).toBe(201);
  const history = await app.request(`/api/blocks/${block.id}/revisions`, { headers: headers() });
  expect(await history.json()).toMatchObject({ items: [{ block_id: block.id }], nextCursor: null });
  const placement = await app.request('/api/placements', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ braneId: other.id, blockId: block.id }),
  });
  const p = await placement.json();
  expect(
    (await app.request(`/api/placements/${p.id}`, { method: 'DELETE', headers: headers() })).status,
  ).toBe(200);
  expect(
    (await app.request(`/api/blocks/${block.id}/revisions`, { headers: headers() })).status,
  ).toBe(200);
});
it('paginates immutable revision history and rejects invalid or foreign cursors', async () => {
  const brane = createBrane(db, actor);
  const block = createTextBlock(db, actor, brane.id);
  for (let version = 0; version < 4; version++) {
    updateBlockLiveState(db, actor, { blockId: block.id, text: `Version ${version}`, version });
    revisions(db).snapshotBlock(actor, block.id);
  }
  const read = (query = '') =>
    app.request(`/api/blocks/${block.id}/revisions${query}`, { headers: headers() });
  const first = await (await read('?limit=2')).json();
  expect(first.items).toHaveLength(2);
  expect(first.nextCursor).toBe(first.items[1].id);
  expect(first.items[0]).not.toHaveProperty('content_json');
  const second = await (await read(`?limit=2&cursor=${first.nextCursor}`)).json();
  expect(second.items).toHaveLength(2);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.items, ...second.items].map((r) => r.id)).size).toBe(4);
  const detail = await (
    await app.request(`/api/revisions/${first.items[0].id}`, { headers: headers() })
  ).json();
  expect(first.items[0]).not.toHaveProperty('content');
  expect(detail).toMatchObject({
    id: first.items[0].id,
    block_id: first.items[0].block_id,
    created_at: first.items[0].created_at,
    content: { format: first.items[0].format, text: first.items[0].preview },
  });
  for (const query of [
    '?limit=0',
    '?limit=51',
    '?limit=1.5',
    '?cursor=invalid',
    `?cursor=${uid()}`,
  ])
    expect((await read(query)).status).toBe(400);
  const foreign = revisions(db).snapshotBlock(actor, createTextBlock(db, actor, brane.id).id);
  expect((await read(`?cursor=${foreign.id}`)).status).toBe(400);
  expect((await app.request(`/api/blocks/${block.id}/revisions`)).status).toBe(401);
});

it('versions geometry and rejects stale or unversioned placement writes', async () => {
  const brane = createBrane(db, actor);
  const { placement } = createTextBlock(db, actor, brane.id);
  const patch = (body: unknown) =>
    app.request(`/api/placements/${placement.id}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify(body),
    });
  const geometry = { x: 10, y: 20, width: 400, height: 250 };
  const first = await patch({ ...geometry, version: 0 });
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({ ...geometry, version: 1, id: placement.id });
  expect((await patch({ ...geometry, x: 999, version: 0 })).status).toBe(409);
  expect((await patch(geometry)).status).toBe(400);
  const current = await app.request(`/api/placements/${placement.id}`, { headers: headers() });
  expect(await current.json()).toMatchObject({ ...geometry, version: 1 });
  const next = await patch({ ...geometry, x: 30, version: 1 });
  expect(await next.json()).toMatchObject({ x: 30, version: 2 });
});
it('does not expose another actor’s placement through read or versioned write', async () => {
  const other = uid();
  db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
    other,
    'Other',
    `${other}@example.com`,
    Date.now(),
    Date.now(),
  );
  const { placement } = createTextBlock(db, other, createBrane(db, other).id);
  expect(
    (await app.request(`/api/placements/${placement.id}`, { headers: headers() })).status,
  ).toBe(404);
  expect(
    (
      await app.request(`/api/placements/${placement.id}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ x: 0, y: 0, width: 320, height: 220, version: 0 }),
      })
    ).status,
  ).toBe(404);
});

it('retains upload recovery intent when bytes succeed but metadata commit fails', async () => {
  const brane = createBrane(db, actor);
  db.exec(
    "CREATE TRIGGER fail_asset_insert BEFORE INSERT ON assets BEGIN SELECT RAISE(ABORT, 'fixture storage metadata failure'); END",
  );
  const form = new FormData();
  form.set(
    'intent',
    JSON.stringify({
      key: uid(),
      braneId: brane.id,
      target: 'canvas',
      geometry: { x: 10, y: 20, width: 320, height: 300 },
    }),
  );
  form.set(
    'file',
    new File(
      [
        await (
          await import('sharp')
        )
          .default({ create: { width: 2, height: 3, channels: 3, background: 'red' } })
          .png()
          .toBuffer(),
      ],
      'test.png',
    ),
  );
  const response = await app.request('/api/imports', {
    method: 'POST',
    headers: { cookie, origin: 'http://localhost:5173' },
    body: form,
  });
  expect(response.status).toBe(500);
  expect((db.prepare('SELECT count(*) n FROM assets').get() as any).n).toBe(0);
  const intent = db.prepare('SELECT * FROM upload_intents').get() as any;
  expect(intent.size).toBeGreaterThan(12);
  expect(stored.has(intent.id)).toBe(true);
});
