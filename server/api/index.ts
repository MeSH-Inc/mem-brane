import { entryApi } from './entry.js';
import { readCard, readUnplacedCards } from '../services/card-library.js';
import { currentLibrary, authorizeLibrary } from '../domain/libraries.js';
import { applyWorkspaceOperation } from '../services/workspace-operations.js';
import { workspaceOperation } from '../../shared/workspace-commands.js';
import { cancelRun } from '../services/run-lifecycle.js';
import { readConfiguration } from '../services/configuration.js';
import type { RunIdentity } from '../../shared/contracts.js';
import { readPdfPages } from '../services/representations.js';
import { MAX_BLOCK_TEXT_CHARACTERS } from '../../shared/limits.js';
import { admitImport } from '../services/capacity.js';
import { readRunPage, readRunDetail } from '../services/run-reads.js';
import { Hono, type Context } from 'hono';
import { createRateLimit } from './rate-limit.js';
import { streamSSE } from 'hono/streaming';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { DB } from '../db/index.js';
import { createImports } from '../services/imports.js';
import { estimateRun } from '../services/estimate.js';
import { budgetState } from '../services/costs.js';
import { config, costPolicy } from '../app/config.js';
import type { createAuth } from '../auth/index.js';
import type { EventHub } from '../sse/hub.js';
import type { AssetStore } from '../storage/assets.js';
import { canEditBrane, DomainError, requireOwned } from '../domain/access.js';
import { errorBody } from '../../shared/errors.js';
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
  readRevision,
  readRevisionPage,
  now,
  uid,
} from '../services/content.js';
import { readSubmissionReceipt, spawnArtifact, submitRun, retryRun } from '../services/runs.js';
import { readInputs, readLineage } from '../services/context-reader.js';
import {
  geometry,
  placementEdit,
  edit,
  id,
  spawnArtifact as spawnSchema,
  submitRun as runSchema,
} from '../../shared/schemas/index.js';
type ApiEnvironment = { Variables: { actor: string; authorize: () => void; guest: boolean } };
async function authorizedBody(c: Context<ApiEnvironment>) {
  const body: unknown = await c.req.json();
  c.get('authorize')();
  return body;
}
export function createApi(
  db: DB,
  auth: ReturnType<typeof createAuth>,
  hub: EventHub,
  store: AssetStore,
) {
  const app = new Hono<ApiEnvironment>();
  const allowRequest = createRateLimit();
  const imports = createImports(db, store);
  app.use('*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin');
      if (origin && origin !== config.APP_ORIGIN)
        return c.json(errorBody('Origin is not allowed', 'forbidden'), 403);
    }
    await next();
  });
  app.use(
    '*',
    bodyLimit({
      maxSize: config.MAX_UPLOAD_BYTES + 65536,
      onError: (c) => c.json(errorBody('Request exceeds size limit', 'too_large'), 413),
    }),
  );
  app.get('/signup-policy', (c) => c.json({ mode: config.SIGNUP_MODE }));
  app.get('/recovery-policy', (c) =>
    c.json({ enabled: Boolean(auth.options.emailAndPassword?.sendResetPassword) }),
  );
  app.on(['GET', 'POST'], '/auth/*', async (c) => {
    // An expired anonymous cookie must not make the plugin clear the newly issued
    // account cookie while it tries to resolve the previous session after login.
    if (
      /\/auth\/(sign-in|sign-up)\/email$/.test(c.req.path) &&
      !(await auth.api.getSession({ headers: c.req.raw.headers }))
    ) {
      const headers = new Headers(c.req.raw.headers);
      headers.delete('cookie');
      return auth.handler(new Request(c.req.raw, { headers }));
    }
    return auth.handler(c.req.raw);
  });
  app.route('/', entryApi(db, auth));
  app.use('*', async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json(errorBody('Sign in required', 'unauthenticated'), 401);
    if (c.req.header('X-Mem-Brane-Actor') && c.req.header('X-Mem-Brane-Actor') !== session.user.id)
      return c.json(
        errorBody('Account changed. Sign in again before synchronizing.', 'unauthenticated'),
        401,
      );
    const library = currentLibrary(
      db,
      session.user.id,
      c.req.header('X-Mem-Brane-Library') ?? c.req.query('library'),
    );
    c.set('actor', library.id);
    c.set('guest', Boolean(session.user.isAnonymous));
    c.set('authorize', () => {
      try {
        authorizeLibrary(db, session.user.id, library.id);
      } catch {
        throw new DomainError(401, 'Workspace access changed. Refresh your session.');
      }
      if (
        session.session &&
        !db
          .prepare(
            "SELECT 1 FROM session WHERE id=? AND (CASE WHEN typeof(expiresAt)='text' THEN unixepoch(expiresAt,'subsec')*1000 ELSE expiresAt END)>?",
          )
          .get(session.session.id, Date.now())
      )
        throw new DomainError(401, 'Session expired. Sign in again.');
    });
    if (
      session.user.isAnonymous &&
      c.req.method === 'POST' &&
      (/^\/(runs|artifacts|ingest)(\/|$)/.test(c.req.path.replace(/^\/api/, '')) ||
        c.req.path.endsWith('/snapshot'))
    )
      throw new DomainError(
        403,
        'Sign in to use AI, webpage imports, and snapshots. Your guest work will be kept.',
        'guest_limit',
      );
    if (!allowRequest(session.user.id))
      return c.json(errorBody('Too many requests; try again shortly', 'rate_limited'), 429);
    await next();
  });
  const limits = {
    costPolicy,
    models: config.models,
    maxTokens: config.MAX_OUTPUT_TOKENS,
    userConcurrency: config.USER_RUN_LIMIT,
    queueLimit: config.RUN_QUEUE_LIMIT,
    maxContextCharacters: config.MAX_CONTEXT_CHARACTERS,
  };
  app.post('/sync/commands', async (c) =>
    c.json(
      applyWorkspaceOperation(
        db,
        c.get('actor'),
        workspaceOperation.parse(await authorizedBody(c)),
      ),
    ),
  );
  app.get('/config', (c) => c.json(readConfiguration(db, c.get('actor'))));
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
      .parse(await authorizedBody(c));
    return c.json(createBrane(db, c.get('actor'), title), 201);
  });
  app.get('/branes/:id', (c) => c.json(readBrane(db, c.get('actor'), id.parse(c.req.param('id')))));
  app.get('/branes/:id/runs', (c) => {
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(50).default(25), cursor: id.optional() })
      .parse(c.req.query());
    return c.json(
      readRunPage(db, c.get('actor'), id.parse(c.req.param('id')), query.limit, query.cursor),
    );
  });
  app.patch('/branes/:id', async (c) => {
    const braneId = id.parse(c.req.param('id'));
    canEditBrane(db, c.get('actor'), braneId);
    const body = z
      .object({ title: z.string().trim().min(1).max(200) })
      .parse(await authorizedBody(c));
    db.prepare('UPDATE branes SET title=?,updated_at=? WHERE id=?').run(body.title, now(), braneId);
    return c.json({ ok: true });
  });
  app.post('/blocks/text', async (c) => {
    const body = z
      .object({ braneId: id, geometry: geometry.optional() })
      .parse(await authorizedBody(c));
    return c.json(createTextBlock(db, c.get('actor'), body.braneId, body.geometry), 201);
  });
  app.get('/blocks/unplaced', (c) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(50).default(25),
        cursor: id.optional(),
      })
      .parse(c.req.query());
    return c.json(readUnplacedCards(db, c.get('actor'), query.limit, query.cursor));
  });
  app.get('/blocks/:id', (c) => c.json(readCard(db, c.get('actor'), id.parse(c.req.param('id')))));
  app.patch('/blocks/live', async (c) =>
    c.json(updateBlockLiveState(db, c.get('actor'), edit.parse(await authorizedBody(c)))),
  );
  app.get('/blocks/:id/revisions', (c) => {
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(50).default(25), cursor: id.optional() })
      .parse(c.req.query());
    return c.json(
      readRevisionPage(db, c.get('actor'), id.parse(c.req.param('id')), query.limit, query.cursor),
    );
  });
  app.get('/operations', (c) =>
    c.json(
      db
        .prepare(
          'SELECT r.id,r.status,r.model,r.created_at,r.started_at,r.finished_at,r.lease_until,(SELECT count(*) FROM run_attempts a WHERE a.run_id=r.id) attempts,c.status cost_status,c.reserved_microusd,c.confirmed_microusd FROM runs r LEFT JOIN spend_commitments c ON c.run_id=r.id WHERE r.owner_id=? ORDER BY r.created_at DESC LIMIT 100',
        )
        .all(c.get('actor')),
    ),
  );
  app.post('/blocks/:id/snapshot', (c) =>
    c.json(revisions(db).snapshotBlock(c.get('actor'), id.parse(c.req.param('id'))), 201),
  );
  app.get('/revisions/:id', (c) =>
    c.json(readRevision(db, c.get('actor'), id.parse(c.req.param('id')))),
  );
  app.post('/placements', async (c) => {
    const body = z
      .object({ braneId: id, blockId: id, geometry: geometry.optional() })
      .parse(await authorizedBody(c));
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
        placementEdit.parse(await authorizedBody(c)),
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
    const input = runSchema.parse(await authorizedBody(c));
    return c.json(estimateRun(db, c.get('actor'), input, limits));
  });
  app.post('/artifacts/spawn', async (c) => {
    const run = spawnArtifact(
      db,
      revisions(db),
      c.get('actor'),
      spawnSchema.parse(await authorizedBody(c)),
      limits,
    );
    hub.publish(c.get('actor'), {
      type: 'run',
      runId: run.id,
      braneId: run.brane_id,
      status: run.status,
    });
    return c.json(readSubmissionReceipt(db, c.get('actor'), run.id), 201);
  });
  app.post('/runs', async (c) => {
    const run = submitRun(
      db,
      revisions(db),
      c.get('actor'),
      runSchema.parse(await authorizedBody(c)),
      limits,
    );
    hub.publish(c.get('actor'), {
      type: 'run',
      runId: run.id,
      braneId: run.brane_id,
      status: run.status,
    });
    return c.json(readSubmissionReceipt(db, c.get('actor'), run.id), 201);
  });
  app.get('/runs/:id', (c) =>
    c.json(readRunDetail(db, c.get('actor'), id.parse(c.req.param('id')))),
  );
  app.post('/runs/:id/cancel', (c) => {
    cancelRun(db, c.get('actor'), id.parse(c.req.param('id')));
    return c.json({ ok: true });
  });
  app.post('/runs/:id/retry', async (c) => {
    const { key } = z.object({ key: id }).parse(await authorizedBody(c));
    const run = retryRun(db, c.get('actor'), id.parse(c.req.param('id')), key, limits);
    return c.json({ runId: run.id, outputBlockId: run.output_block_id } satisfies RunIdentity, 201);
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
        try {
          c.get('authorize')();
        } catch {
          resolve();
          return;
        }
        pending.set(event.runId, event);
      });
      const pump = async () => {
        if (closed || sending || !pending.size) return;
        try {
          c.get('authorize')();
        } catch {
          resolve();
          return;
        }
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
        try {
          c.get('authorize')();
        } catch {
          resolve();
          return;
        }
        if (!closed && !sending)
          void stream
            .writeSSE({ event: 'ping', data: JSON.stringify({ time: now() }) })
            .catch(resolve);
      }, 15000);
      stream.onAbort(resolve);
      hub.signal.addEventListener('abort', resolve, { once: true });
      if (hub.signal.aborted) resolve();
      try {
        await stream.writeSSE({ event: 'ready', data: JSON.stringify({ reconcile: true }) });
        await done;
      } finally {
        closed = true;
        clearInterval(updates);
        clearInterval(ping);
        unsubscribe();
        hub.signal.removeEventListener('abort', resolve);
      }
    }),
  );
  app.post('/imports', async (c) => {
    const body = await c.req.parseBody();
    c.get('authorize')();
    let intent: unknown;
    try {
      intent = JSON.parse(String(body.intent));
    } catch {
      throw new DomainError(400, 'Invalid import intent');
    }
    return c.json(
      await imports.import(c.get('actor'), intent, body.file as File, c.get('authorize')),
      201,
    );
  });
  app.get('/imports/:key', (c) =>
    c.json(imports.status(c.get('actor'), id.parse(c.req.param('key')))),
  );
  app.get('/representations/:id/pages', (c) =>
    c.json(
      readPdfPages(
        db,
        c.get('actor'),
        z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(c.req.param('id')),
      ),
    ),
  );
  app.get('/assets/:id', async (c) => {
    const asset = requireOwned(db, 'assets', c.get('actor'), id.parse(c.req.param('id')));
    c.header('Content-Type', asset.mime);
    if (asset.mime === 'application/pdf')
      c.header('Content-Disposition', 'attachment; filename="document.pdf"');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'private, max-age=300');
    const bytes = new Uint8Array(await store.get(asset.storage_key));
    c.get('authorize')();
    return c.body(bytes);
  });
  app.post('/ingest', async (c) => {
    const body = z
      .object({
        braneId: id,
        url: z.string().url().max(2048),
        text: z.string().max(MAX_BLOCK_TEXT_CHARACTERS).optional(),
      })
      .parse(await authorizedBody(c));
    canEditBrane(db, c.get('actor'), body.braneId);
    const block = db.transaction(() => {
      if (!body.text)
        admitImport(db, c.get('actor'), config.USER_IMPORT_LIMIT, config.IMPORT_QUEUE_LIMIT);
      const b = createBlock(
        db,
        c.get('actor'),
        'webpage',
        {
          format: 'webpage',
          url: body.url,
          text: body.text ?? '',
          status: body.text ? 'ready' : 'pending',
        },
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
        errorBody('Invalid request', 'invalid_request', {
          details: error.issues.map((i) => ({ path: i.path, message: i.message })),
        }),
        400,
      );
    if (error instanceof DomainError)
      return c.json(errorBody(error.message, error.code), error.status);
    const requestId = crypto.randomUUID();
    console.error('API error', requestId, error);
    return c.json(errorBody('An unexpected error occurred', 'internal', { requestId }), 500);
  });
  return app;
}
