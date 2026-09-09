import { expect, it } from 'vitest';
import { Hono } from 'hono';
import { openDatabase } from '../server/db/index';
import { createAuth } from '../server/auth';
import { createApi } from '../server/api';
import { EventHub } from '../server/sse/hub';
import { createBrane, createTextBlock, uid } from '../server/services/content';
import type { AssetStore } from '../server/storage/assets';
it('exposes authenticated Spawn, frozen inspection, durable links, and idempotent delivery', async () => {
  const db = openDatabase(':memory:');
  try {
    const auth = createAuth(db);
    const signed = await auth.api.signUpEmail({
      body: {
        email: `${uid()}@example.com`,
        password: 'valid-test-password',
        name: 'Spawn tester',
      },
      asResponse: true,
    });
    const actor = (await signed.json()).user.id;
    const cookie = signed.headers
      .getSetCookie()
      .map((s) => s.split(';')[0])
      .join('; ');
    const store: AssetStore = {
      async put() {},
      async get() {
        return new Uint8Array();
      },
      async delete() {},
      async createReadUrl() {
        return '';
      },
    };
    const app = new Hono();
    app.route('/api', createApi(db, auth, new EventHub(), store));
    const brane = createBrane(db, actor);
    const source = createTextBlock(db, actor, brane.id);
    const body = JSON.stringify({
      braneId: brane.id,
      key: uid(),
      sourceBlockIds: [source.id],
      anchorPlacementId: source.placement.id,
      action: 'develop',
      model: 'mock',
      edits: [{ blockId: source.id, text: 'Unsaved API source', version: 0 }],
    });
    const headers = { cookie, origin: 'http://localhost:5173', 'Content-Type': 'application/json' };
    expect((await app.request('/api/artifacts/spawn', { method: 'POST', body })).status).toBe(401);
    const response = await app.request('/api/artifacts/spawn', { method: 'POST', headers, body });
    expect(response.status).toBe(201);
    const run = await response.json();
    const duplicate = await app.request('/api/artifacts/spawn', { method: 'POST', headers, body });
    expect((await duplicate.json()).runId).toBe(run.runId);
    const inspection = await (await app.request(`/api/runs/${run.runId}`, { headers })).json();
    expect(inspection.inputs[0]).toMatchObject({
      kind: 'source',
      content: { format: 'text', text: 'Unsaved API source' },
    });
    expect(inspection.cost).toBeTruthy();
    const state = await (await app.request(`/api/branes/${brane.id}`, { headers })).json();
    expect(state.derivations).toHaveLength(1);
    expect(state.blocks.find((b: any) => b.id === run.outputBlockId)).toMatchObject({
      kind: 'text',
      origin: 'generated',
    });
    const invalid = await app.request('/api/artifacts/spawn', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...JSON.parse(body), key: uid(), prompt: 'Composer must not leak' }),
    });
    expect(invalid.status).toBe(400);
  } finally {
    db.close();
  }
});
