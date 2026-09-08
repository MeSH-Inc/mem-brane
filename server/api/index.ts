import { Hono } from 'hono';
import { createRateLimit } from './rate-limit.js';
import { streamSSE } from 'hono/streaming';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { DB } from '../db/index.js';
import { createHash } from 'node:crypto';
import { estimateRun } from '../services/estimate.js';
import { budgetState } from '../services/costs.js';
import { config, costPolicy } from '../app/config.js';
import type { createAuth } from '../auth/index.js';
import type { EventHub } from '../sse/hub.js';
import type { AssetStore } from '../storage/assets.js';
import { imageMime } from '../storage/assets.js';
import { canEditBrane, DomainError, requireOwned } from '../domain/access.js';
import {
  createBrane,
  createTextBlock,
  createBlock,
  createPlacement,
  readBrane,
  updateBlockLiveState,
  updatePlacementGeometry,
  getPlacement,
  removePlacement,
  revisions,
  now,
  uid,
} from '../services/content.js';
import {
  spawnArtifact,
  submitRun,
  cancelRun,
  retryRun,
  readInputs,
  readLineage,
} from '../services/runs.js';
import {
  geometry,
  placementEdit,
  edit,
  id,
  spawnArtifact as spawnSchema,
  submitRun as runSchema,
} from '../../shared/schemas/index.js';
export function createApi(
  db: DB,
  auth: ReturnType<typeof createAuth>,
  hub: EventHub,
  store: AssetStore,
) {
  const app = new Hono<{ Variables: { actor: string } }>();
  const allowRequest = createRateLimit();
  app.use('*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin');
      if (origin && origin !== config.APP_ORIGIN)
        return c.json({ error: 'Origin is not allowed' }, 403);
    }
    await next();
  });
  app.use(
    '*',
    bodyLimit({
      maxSize: config.MAX_UPLOAD_BYTES + 65536,
      onError: (c) => c.json({ error: 'Request exceeds size limit' }, 413),
    }),
  );
  app.on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw));
  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Sign in required' }, 401);
    c.set('actor', session.user.id);
    if (!allowRequest(session.user.id))
      return c.json({ error: 'Too many requests; try again shortly' }, 429);
    await next();
  });
  const limits = {
    costPolicy,
    models: config.models,
    maxTokens: config.MAX_OUTPUT_TOKENS,
    userConcurrency: config.USER_RUN_LIMIT,
    maxContextCharacters: config.MAX_CONTEXT_CHARACTERS,
  };
  app.get('/config', (c) =>
    c.json({
      models: config.models,
      defaultModel: config.defaultModel,
      maxOutputTokens: config.MAX_OUTPUT_TOKENS,
      dailySpendEnforced: true,
      modelCapabilities: Object.fromEntries(
        config.models.map((m) => [
          m,
          { vision: m === 'mock' || costPolicy.prices[m]?.vision === true },
        ]),
      ),
      budget: budgetState(db, c.get('actor'), costPolicy),
    }),
  );
  app.get('/branes', (c) =>
    c.json(
      db
        .prepare(
          'SELECT id,title,created_at,updated_at FROM branes WHERE owner_id=? ORDER BY updated_at DESC',
        )
        .all(c.get('actor')),
    ),
  );
  app.post('/branes', async (c) => {
    const { title } = z
      .object({ title: z.string().trim().min(1).max(200).default('Untitled brane') })
      .parse(await c.req.json());
    return c.json(createBrane(db, c.get('actor'), title), 201);
  });
  app.get('/branes/:id', (c) => c.json(readBrane(db, c.get('actor'), id.parse(c.req.param('id')))));
  app.patch('/branes/:id', async (c) => {
    const braneId = id.parse(c.req.param('id'));
    canEditBrane(db, c.get('actor'), braneId);
    const body = z.object({ title: z.string().trim().min(1).max(200) }).parse(await c.req.json());
    db.prepare('UPDATE branes SET title=?,updated_at=? WHERE id=?').run(body.title, now(), braneId);
    return c.json({ ok: true });
  });
  app.post('/blocks/text', async (c) => {
    const body = z.object({ braneId: id, geometry: geometry.optional() }).parse(await c.req.json());
    return c.json(createTextBlock(db, c.get('actor'), body.braneId, body.geometry), 201);
  });
  app.patch('/blocks/live', async (c) =>
    c.json(updateBlockLiveState(db, c.get('actor'), edit.parse(await c.req.json()))),
  );
  app.get('/blocks/:id/revisions', (c) => {
    const blockId = id.parse(c.req.param('id'));
    requireOwned(db, 'blocks', c.get('actor'), blockId);
    return c.json(
      (
        db
          .prepare('SELECT * FROM block_revisions WHERE block_id=? ORDER BY created_at DESC')
          .all(blockId) as any[]
      ).map((r) => ({ ...r, content: JSON.parse(r.content_json) })),
    );
  });
  app.get('/operations', (c) =>
    c.json(
      db
        .prepare(
          'SELECT r.id,r.status,r.model,r.created_at,r.started_at,r.finished_at,r.lease_until,(SELECT count(*) FROM run_attempts a WHERE a.run_id=r.id) attempts,c.status cost_status,c.reserved_microusd,c.confirmed_microusd FROM runs r LEFT JOIN run_costs c ON c.run_id=r.id WHERE r.owner_id=? ORDER BY r.created_at DESC LIMIT 100',
        )
        .all(c.get('actor')),
    ),
  );
  app.post('/blocks/:id/snapshot', (c) =>
    c.json(revisions(db).snapshotBlock(c.get('actor'), id.parse(c.req.param('id'))), 201),
  );
  app.get('/revisions/:id', (c) => {
    const row = db
      .prepare('SELECT * FROM block_revisions WHERE id=?')
      .get(id.parse(c.req.param('id'))) as any;
    if (!row) throw new DomainError(404, 'Revision not found');
    requireOwned(db, 'blocks', c.get('actor'), row.block_id);
    return c.json({ ...row, content: JSON.parse(row.content_json) });
  });
  app.post('/placements', async (c) => {
    const body = z
      .object({ braneId: id, blockId: id, geometry: geometry.optional() })
      .parse(await c.req.json());
    return c.json(
      createPlacement(db, c.get('actor'), body.braneId, body.blockId, body.geometry),
      201,
    );
  });
  app.get('/placements/:id', (c) =>
    c.json(getPlacement(db, c.get('actor'), id.parse(c.req.param('id')))),
  );
  app.patch('/placements/:id', async (c) =>
    c.json(
      updatePlacementGeometry(
        db,
        c.get('actor'),
        id.parse(c.req.param('id')),
        placementEdit.parse(await c.req.json()),
      ),
    ),
  );
  app.delete('/placements/:id', (c) => {
    removePlacement(db, c.get('actor'), id.parse(c.req.param('id')));
    return c.json({ ok: true });
  });
  app.get('/context/lineage/:id', (c) =>
    c.json(readLineage(db, c.get('actor'), id.parse(c.req.param('id')))),
  );
  app.post('/runs/estimate', async (c) => {
    const input = runSchema.parse(await c.req.json());
    if (!config.models.includes(input.model)) throw new DomainError(400, 'Model is not allowed');
    return c.json(estimateRun(db, c.get('actor'), input, config.MAX_OUTPUT_TOKENS, costPolicy));
  });
  app.post('/artifacts/spawn', async (c) => {
    const run = spawnArtifact(
      db,
      revisions(db),
      c.get('actor'),
      spawnSchema.parse(await c.req.json()),
      limits,
    );
    hub.publish(c.get('actor'), {
      type: 'run',
      runId: run.id,
      braneId: run.brane_id,
      status: run.status,
    });
    return c.json(run, 201);
  });
  app.post('/runs', async (c) => {
    const run = submitRun(
      db,
      revisions(db),
      c.get('actor'),
      runSchema.parse(await c.req.json()),
      limits,
    );
    hub.publish(c.get('actor'), {
      type: 'run',
      runId: run.id,
      braneId: run.brane_id,
      status: run.status,
    });
    return c.json(run, 201);
  });
  app.get('/runs/:id', (c) => {
    const run = requireOwned(db, 'runs', c.get('actor'), id.parse(c.req.param('id')));
    return c.json({
      ...run,
      inputs: readInputs(db, run.id),
      output: db.prepare('SELECT * FROM run_outputs WHERE run_id=?').get(run.id),
      cost: db.prepare('SELECT * FROM run_costs WHERE run_id=?').get(run.id),
      checkpoint: db.prepare('SELECT * FROM run_checkpoints WHERE run_id=?').get(run.id),
    });
  });
  app.post('/runs/:id/cancel', (c) => {
    cancelRun(db, c.get('actor'), id.parse(c.req.param('id')));
    return c.json({ ok: true });
  });
  app.post('/runs/:id/retry', async (c) => {
    const { key } = z.object({ key: id }).parse(await c.req.json());
    return c.json(retryRun(db, c.get('actor'), id.parse(c.req.param('id')), key, limits), 201);
  });
  app.get('/budget', (c) => c.json(budgetState(db, c.get('actor'), costPolicy)));
  app.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      let resolve!: () => void;
      const done = new Promise<void>((r) => {
        resolve = r;
      });
      let closed = false,
        sending = false;
      const pending = new Map<string, unknown>();
      const unsubscribe = hub.subscribe(c.get('actor'), (event) => {
        pending.set(event.runId, event);
      });
      const pump = async () => {
        if (closed || sending || !pending.size) return;
        sending = true;
        const batch = [...pending.values()];
        pending.clear();
        try {
          for (const event of batch)
            await stream.writeSSE({ event: 'run', data: JSON.stringify(event) });
        } catch {
          resolve();
        } finally {
          sending = false;
        }
      };
      const updates = setInterval(() => void pump(), 100);
      const ping = setInterval(() => {
        if (!closed && !sending)
          void stream
            .writeSSE({ event: 'ping', data: JSON.stringify({ time: now() }) })
            .catch(resolve);
      }, 15000);
      stream.onAbort(resolve);
      try {
        await stream.writeSSE({ event: 'ready', data: JSON.stringify({ reconcile: true }) });
        await done;
      } finally {
        closed = true;
        clearInterval(updates);
        clearInterval(ping);
        unsubscribe();
      }
    }),
  );
  app.post('/assets', async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;
    const braneId = id.parse(body.braneId);
    canEditBrane(db, c.get('actor'), braneId);
    if (!(file instanceof File) || file.size > config.MAX_UPLOAD_BYTES)
      throw new DomainError(400, 'Choose an image within the upload limit');
    const bytes = new Uint8Array(await file.arrayBuffer()),
      mime = imageMime(bytes);
    if (!mime) throw new DomainError(400, 'Only PNG, JPEG, GIF and WebP images are supported');
    const assetId = uid();
    const assetHash = createHash('sha256').update(bytes).digest('hex');
    await store.put(assetId, bytes, mime);
    try {
      const block = db.transaction(() => {
        db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?)').run(
          assetId,
          c.get('actor'),
          assetId,
          mime,
          bytes.length,
          now(),
        );
        return createBlock(
          db,
          c.get('actor'),
          'image',
          { text: file.name.slice(0, 200), assetId, assetHash, mimeType: mime },
          braneId,
        );
      })();
      return c.json(block, 201);
    } catch (error) {
      await store.delete(assetId);
      throw error;
    }
  });
  app.get('/assets/:id', async (c) => {
    const asset = requireOwned(db, 'assets', c.get('actor'), id.parse(c.req.param('id')));
    c.header('Content-Type', asset.mime);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'private, max-age=300');
    return c.body((await store.get(asset.storage_key)) as any);
  });
  app.post('/ingest', async (c) => {
    const body = z
      .object({
        braneId: id,
        url: z.string().url().max(2048),
        text: z.string().max(100000).optional(),
      })
      .parse(await c.req.json());
    canEditBrane(db, c.get('actor'), body.braneId);
    const block = db.transaction(() => {
      const b = createBlock(
        db,
        c.get('actor'),
        'webpage',
        { url: body.url, text: body.text ?? '', status: body.text ? 'ready' : 'pending' },
        body.braneId,
      );
      if (!body.text)
        db.prepare("INSERT INTO ingestions VALUES (?,'queued',NULL,?)").run(b.id, now());
      return b;
    })();
    return c.json(block, 201);
  });
  app.onError((error, c) => {
    if (error instanceof z.ZodError)
      return c.json(
        {
          error: 'Invalid request',
          details: error.issues.map((i) => ({ path: i.path, message: i.message })),
        },
        400,
      );
    if (error instanceof DomainError) return c.json({ error: error.message }, error.status as any);
    console.error('API error', error);
    return c.json({ error: 'An unexpected error occurred' }, 500);
  });
  return app;
}
