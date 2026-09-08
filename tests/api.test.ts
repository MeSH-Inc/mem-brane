import { afterEach, beforeEach, expect, it } from 'vitest';
import { Hono } from 'hono';
import { openDatabase, type DB } from '../server/db/index';
import { createAuth } from '../server/auth/index';
import { createApi } from '../server/api/index';
import { EventHub } from '../server/sse/hub';
import type { AssetStore } from '../server/storage/assets';
import { createBrane, createTextBlock, uid } from '../server/services/content';
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
  const inspect = await app.request(`/api/runs/${run.id}`, { headers: headers() });
  const inspected = await inspect.json();
  expect(inspected.inputs[0].content.text).toBe('Frozen from API');
  const reload = await app.request(`/api/branes/${brane.id}`, { headers: headers() });
  expect((await reload.json()).runs[0].id).toBe(run.id);
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
  db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?)').run(
    asset,
    other,
    asset,
    'image/png',
    12,
    Date.now(),
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
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=',
    'base64',
  );
  const body = new FormData();
  body.append('braneId', brane.id);
  body.append('file', new File([bytes], 'pixel.png', { type: 'image/png' }));
  const response = await app.request('/api/assets', {
    method: 'POST',
    headers: { cookie, origin: 'http://localhost:5173' },
    body,
  });
  expect(response.status).toBe(201);
  const block = await response.json();
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
  expect(await history.json()).toHaveLength(1);
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
