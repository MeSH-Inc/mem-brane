import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { DB } from '../db/index.js';
import type { createAuth } from '../auth/index.js';
import { config } from '../app/config.js';
import { currentLibrary, librariesFor } from '../domain/libraries.js';
import { DomainError } from '../domain/access.js';
import { createBrane } from '../services/content.js';
import {
  completeGuestClaim,
  prepareGuestClaim,
  claimLifetime,
  guestHasWork,
  guestStarterTitle,
} from '../services/guest-claims.js';

const proofCookie = 'mem-brane-claim';
type User = { id: string; name: string; email: string; isAnonymous?: boolean | null };
export function entryApi(db: DB, auth: ReturnType<typeof createAuth>) {
  const app = new Hono();
  function sessionView(user: User, requested?: string, claimPending = false) {
    const libraries = librariesFor(db, user.id).map((item) => ({
      id: item.id,
      kind: item.id === user.id ? ('personal' as const) : ('kept' as const),
      createdAt: item.created_at,
      branes: (
        db.prepare('SELECT COUNT(*) n FROM branes WHERE owner_id=?').get(item.id) as { n: number }
      ).n,
    }));
    // Without an explicit choice, open the personal library unless only kept work has content.
    const library =
      libraries.find((item) => item.id === requested) ??
      libraries.find((item) => item.kind === 'personal' && item.branes) ??
      libraries.find((item) => item.branes) ??
      libraries[0];
    if (!library) throw new DomainError(403, 'No library is available for this account.');
    const guest = db
      .prepare('SELECT expires_at FROM guest_libraries WHERE library_id=? AND claimed_by IS NULL')
      .get(library.id) as { expires_at: number } | undefined;
    return {
      user: { ...user, isAnonymous: Boolean(user.isAnonymous) },
      libraryId: library.id,
      libraries,
      guestExpiresAt: guest?.expires_at ?? null,
      claimPending,
    };
  }
  app.get('/entry-policy', (c) => c.json({ guest: config.GUEST_MODE === 'enabled' }));
  app.get('/session', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json(null);
    let requested = c.req.query('library') ?? c.req.header('X-Mem-Brane-Library');
    const brane = c.req.query('brane');
    if (brane) {
      const target = db
        .prepare(
          'SELECT b.owner_id FROM branes b JOIN libraries l ON l.id=b.owner_id WHERE b.id=? AND l.principal_id=?',
        )
        .get(brane, session.user.id) as { owner_id: string } | undefined;
      if (target) requested = target.owner_id;
    }
    return c.json(sessionView(session.user, requested, !!getCookie(c, proofCookie)));
  });
  app.post('/guest/start', async (c) => {
    let session = await auth.api.getSession({ headers: c.req.raw.headers });
    let user: User;
    if (session) user = session.user;
    else {
      const response = await auth.handler(
        new Request(new URL('/api/auth/sign-in/anonymous', config.APP_ORIGIN), {
          method: 'POST',
          headers: c.req.raw.headers,
          body: '{}',
        }),
      );
      if (!response.ok) return response;
      for (const cookie of response.headers.getSetCookie())
        c.header('Set-Cookie', cookie, { append: true });
      user = (await response.json()).user as User;
    }
    const library = currentLibrary(db, user.id);
    const brane = db
      .transaction(() => {
        const existing = db
          .prepare('SELECT id FROM branes WHERE owner_id=? ORDER BY created_at LIMIT 1')
          .get(library.id) as { id: string } | undefined;
        return existing ?? createBrane(db, library.id, guestStarterTitle);
      })
      .immediate();
    return c.json({ session: sessionView(user, library.id), braneId: brane.id });
  });
  app.post('/guest/prepare-claim', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session?.user.isAnonymous) throw new DomainError(401, 'A guest session is required.');
    const library = librariesFor(db, session.user.id)[0];
    if (!library) throw new DomainError(403, 'No guest workspace is available.');
    const body = (await c.req.json().catch(() => ({}))) as { pending?: unknown };
    const pending = typeof body.pending === 'number' && body.pending > 0;
    if (!pending && !guestHasWork(db, library.id)) {
      deleteCookie(c, proofCookie, { path: '/api' });
      return c.json({ ok: true, claim: false });
    }
    const token = prepareGuestClaim(db, session.user.id, library.id, getCookie(c, proofCookie));
    setCookie(c, proofCookie, token, {
      httpOnly: true,
      sameSite: 'Strict',
      secure: process.env.NODE_ENV === 'production',
      path: '/api',
      maxAge: claimLifetime / 1000,
    });
    return c.json({ ok: true, claim: true });
  });
  app.post('/guest/claim', async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session || session.user.isAnonymous)
      throw new DomainError(401, 'Sign in to keep this workspace.');
    const token = getCookie(c, proofCookie);
    if (!token) return c.json(sessionView(session.user, c.req.header('X-Mem-Brane-Library')));
    try {
      const libraryId = completeGuestClaim(db, session.user.id, token);
      deleteCookie(c, proofCookie, { path: '/api' });
      return c.json(sessionView(session.user, libraryId));
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      deleteCookie(c, proofCookie, { path: '/api' });
      return c.json({ error: error.message }, error.status);
    }
  });
  return app;
}
