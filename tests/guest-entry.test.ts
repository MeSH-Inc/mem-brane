import { afterEach, beforeEach, expect, it } from 'vitest';
import type { BetterAuthOptions } from 'better-auth';
import { Hono } from 'hono';
import { openDatabase, type DB } from '../server/db';
import { createAuth } from '../server/auth';
import { createApi } from '../server/api';
import { EventHub } from '../server/sse/hub';
import { config } from '../server/app/config';
import { createBrane, createTextBlock, uid } from '../server/services/content';
import { reserveUpload } from '../server/services/capacity';
import { completeGuestClaim } from '../server/services/guest-claims';

let db: DB, app: Hono;
beforeEach(() => {
  db = openDatabase(':memory:');
  const auth = createAuth(db);
  const options: BetterAuthOptions = auth.options;
  options.rateLimit = { enabled: false };
  app = new Hono();
  app.route(
    '/api',
    createApi(db, auth, new EventHub(), {
      async get() {
        return new Uint8Array();
      },
      async put() {},
      async delete() {},
      async createReadUrl() {
        return '';
      },
    }),
  );
});
afterEach(() => db.close());
function browser() {
  const jar = new Map<string, string>();
  return {
    get cookie() {
      return [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
    },
    async request(
      path: string,
      body?: unknown,
      options: {
        acceptCookies?: boolean;
        cookie?: string;
        library?: string;
        principal?: string;
      } = {},
    ) {
      const response = await app.request(`/api${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          cookie: options.cookie ?? this.cookie,
          origin: config.APP_ORIGIN,
          'content-type': 'application/json',
          ...(options.library ? { 'X-Mem-Brane-Library': options.library } : {}),
          ...(options.principal ? { 'X-Mem-Brane-Actor': options.principal } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (options.acceptCookies !== false)
        for (const item of response.headers.getSetCookie()) {
          const [key, ...parts] = item.split(';')[0].split('=');
          jar.set(key, parts.join('='));
        }
      return response;
    },
  };
}
const credentials = () => ({
  name: 'Keeper',
  email: `${uid()}@example.com`,
  password: 'guest-test-password',
});
async function start(client = browser()) {
  const response = await client.request('/guest/start', {});
  expect(response.status).toBe(200);
  return { client, ...(await response.json()) } as {
    client: ReturnType<typeof browser>;
    braneId: string;
    session: { libraryId: string; user: { id: string; isAnonymous: boolean } };
  };
}
it('opens an isolated guest brane, reuses the session, and denies server-only guest capabilities', async () => {
  const a = await start(),
    b = await start();
  expect(a.session.user.isAnonymous).toBe(true);
  expect((await a.client.request('/guest/start', {})).status).toBe(200);
  expect(db.prepare('SELECT COUNT(*) n FROM guest_libraries').get()).toEqual({ n: 2 });
  expect((await b.client.request(`/branes/${a.braneId}`)).status).toBe(404);
  expect(
    (await b.client.request('/branes', undefined, { library: a.session.libraryId })).status,
  ).toBe(403);
  expect((await a.client.request('/blocks/text', { braneId: a.braneId })).status).toBe(201);
  for (const path of [
    '/runs',
    '/runs/estimate',
    '/artifacts/spawn',
    '/ingest',
    `/blocks/${uid()}/snapshot`,
    `/assets/${uid()}/ocr/quote`,
  ])
    expect((await a.client.request(path, {})).status, path).toBe(403);
});
it('registration claims the same library and retries a lost claim acknowledgement exactly once', async () => {
  const guest = await start();
  const oldCookie = guest.client.cookie;
  const block = createTextBlock(db, guest.session.libraryId, guest.braneId);
  const key = uid();
  expect(
    (
      await guest.client.request('/sync/commands', {
        key,
        command: { type: 'text.edit', blockId: block.id, text: 'Keep me', version: 0 },
      })
    ).status,
  ).toBe(200);
  expect((await guest.client.request('/guest/prepare-claim', {})).status).toBe(200);
  const signup = await guest.client.request('/auth/sign-up/email', credentials());
  expect(signup.status).toBe(200);
  const account = (await signup.json()).user.id;
  // The callback committed the claim, but the client loses the explicit receipt.
  const first = await guest.client.request('/guest/claim', {}, { acceptCookies: false });
  expect(first.status).toBe(200);
  expect((await first.json()).libraryId).toBe(guest.session.libraryId);
  const second = await guest.client.request('/guest/claim', {});
  expect(second.status).toBe(200);
  expect((await second.json()).libraryId).toBe(guest.session.libraryId);
  const state = await (
    await guest.client.request(`/branes/${guest.braneId}`, undefined, {
      library: guest.session.libraryId,
      principal: account,
    })
  ).json();
  expect(state.blocks[0]).toMatchObject({ id: block.id, version: 1, content: { text: 'Keep me' } });
  expect(
    (
      await guest.client.request(
        '/sync/commands',
        { key, command: { type: 'text.edit', blockId: block.id, text: 'Keep me', version: 0 } },
        { library: guest.session.libraryId, principal: account },
      )
    ).status,
  ).toBe(200);
  expect(db.prepare('SELECT COUNT(*) n FROM workspace_operations').get()).toEqual({ n: 1 });
  expect(db.prepare('SELECT COUNT(*) n FROM library_claims').get()).toEqual({ n: 1 });
  expect(
    (await guest.client.request(`/branes/${guest.braneId}`, undefined, { cookie: oldCookie }))
      .status,
  ).toBe(401);
  expect(
    (
      await guest.client.request('/branes', undefined, {
        library: guest.session.libraryId,
        principal: guest.session.user.id,
      })
    ).status,
  ).toBe(401);
});
it('existing-account sign-in adds a library without replacing existing content or accepting another claimant', async () => {
  const member = browser(),
    login = credentials();
  const account = (await (await member.request('/auth/sign-up/email', login)).json()).user.id;
  const existing = createBrane(db, account, 'Existing work');
  const guest = await start();
  await guest.client.request('/guest/prepare-claim', { pending: 1 });
  const token = decodeURIComponent(
    guest.client.cookie
      .split('; ')
      .find((c) => c.startsWith('mem-brane-claim='))!
      .split('=')[1],
  );
  const response = await guest.client.request('/auth/sign-in/email', login);
  expect(response.status).toBe(200);
  expect((await guest.client.request('/guest/claim', {})).status).toBe(200);
  expect(db.prepare('SELECT id FROM libraries WHERE principal_id=?').all(account)).toHaveLength(2);
  expect((await member.request(`/branes/${existing.id}`)).status).toBe(200);
  expect(
    (
      await member.request(`/branes/${guest.braneId}`, undefined, {
        library: guest.session.libraryId,
      })
    ).status,
  ).toBe(200);
  const other = browser();
  const otherId = (await (await other.request('/auth/sign-up/email', credentials())).json()).user
    .id;
  expect(() => completeGuestClaim(db, otherId, token)).toThrow('already claimed');
  expect(
    (
      await other.request(`/branes/${guest.braneId}`, undefined, {
        library: guest.session.libraryId,
      })
    ).status,
  ).toBe(403);
  expect(db.pragma('foreign_key_check')).toEqual([]);
});
it('leaves an untouched guest workspace unclaimed so accounts gain no empty library', async () => {
  const member = browser(),
    login = credentials();
  const account = (await (await member.request('/auth/sign-up/email', login)).json()).user.id;
  createBrane(db, account, 'Existing work');
  const guest = await start();
  const prepared = await guest.client.request('/guest/prepare-claim', {});
  expect(await prepared.json()).toEqual({ ok: true, claim: false });
  expect(guest.client.cookie).not.toMatch(/mem-brane-claim=[^;]/);
  expect((await guest.client.request('/auth/sign-in/email', login)).status).toBe(200);
  const session = await (await guest.client.request('/guest/claim', {})).json();
  expect(session.libraryId).toBe(account);
  expect(session.libraries).toEqual([
    { id: account, kind: 'personal', createdAt: expect.any(Number), branes: 1 },
  ]);
  const newcomer = await start();
  await newcomer.client.request('/guest/prepare-claim', {});
  const signup = await newcomer.client.request('/auth/sign-up/email', credentials());
  const created = (await signup.json()).user.id;
  expect(db.prepare('SELECT id FROM libraries WHERE principal_id=?').all(created)).toHaveLength(1);
  expect(db.prepare('SELECT COUNT(*) n FROM library_claims').get()).toEqual({ n: 0 });
});
it('requires guest-session proof before issuing a claim and never trusts submitted library IDs', async () => {
  const guest = await start(),
    stranger = browser();
  expect(
    (await stranger.request('/guest/prepare-claim', { libraryId: guest.session.libraryId })).status,
  ).toBe(401);
  await stranger.request('/auth/sign-up/email', credentials());
  await stranger.request('/guest/claim', { libraryId: guest.session.libraryId });
  expect(
    db.prepare('SELECT principal_id FROM libraries WHERE id=?').get(guest.session.libraryId),
  ).toEqual({ principal_id: guest.session.user.id });
});

it('completes a prepared claim after the guest login session disappears before authentication', async () => {
  const guest = await start();
  await guest.client.request('/guest/prepare-claim', { pending: 1 });
  db.prepare('DELETE FROM session WHERE userId=?').run(guest.session.user.id);
  const signup = await guest.client.request('/auth/sign-up/email', credentials());
  expect(signup.status).toBe(200);
  expect(db.prepare('SELECT COUNT(*) n FROM library_claims').get()).toEqual({ n: 0 });
  const completed = await guest.client.request('/guest/claim', {});
  expect(completed.status).toBe(200);
  expect((await completed.json()).libraryId).toBe(guest.session.libraryId);
});
it('bounds guest blocks and operation receipts while retaining exactly-once retries', async () => {
  const limits = [config.GUEST_MAX_BLOCKS, config.GUEST_MAX_OPERATIONS];
  try {
    config.GUEST_MAX_BLOCKS = 1;
    config.GUEST_MAX_OPERATIONS = 1;
    const guest = await start();
    const block = createTextBlock(db, guest.session.libraryId, guest.braneId);
    expect((await guest.client.request('/blocks/text', { braneId: guest.braneId })).status).toBe(
      429,
    );
    const operation = {
      key: uid(),
      command: { type: 'text.edit', blockId: block.id, text: 'At the limit', version: 0 },
    };
    expect((await guest.client.request('/sync/commands', operation)).status).toBe(200);
    expect((await guest.client.request('/sync/commands', operation)).status).toBe(200);
    expect(
      (await guest.client.request('/sync/commands', { ...operation, key: uid() })).status,
    ).toBe(429);
  } finally {
    [config.GUEST_MAX_BLOCKS, config.GUEST_MAX_OPERATIONS] = limits;
  }
});
it('bounds guest bytes across identities and keeps failed object deletions charged', async () => {
  const limit = config.GUEST_TOTAL_STORAGE_BYTES;
  try {
    config.GUEST_TOTAL_STORAGE_BYTES = 100;
    const a = await start(),
      b = await start();
    db.prepare('INSERT INTO guest_object_deletions VALUES (?,?,?)').run(
      uid(),
      a.session.libraryId,
      60,
    );
    expect(() =>
      reserveUpload(db, b.session.libraryId, uid(), 60, { userBytes: 1000, totalBytes: 1000 }),
    ).toThrow('Guest upload capacity');
  } finally {
    config.GUEST_TOTAL_STORAGE_BYTES = limit;
  }
});
it('expires guest access but permits a proven claim during the seven-day recovery grace', async () => {
  const guest = await start();
  db.prepare('UPDATE guest_libraries SET expires_at=? WHERE library_id=?').run(
    Date.now() - 1000,
    guest.session.libraryId,
  );
  expect((await guest.client.request('/branes')).status).toBe(401);
  expect((await guest.client.request('/guest/prepare-claim', { pending: 1 })).status).toBe(200);
  expect((await guest.client.request('/auth/sign-up/email', credentials())).status).toBe(200);
  expect((await guest.client.request('/guest/claim', {})).status).toBe(200);
  expect(
    (await guest.client.request('/branes', undefined, { library: guest.session.libraryId })).status,
  ).toBe(200);
});
it('enforces guest creation capacity in the database even when bypassing the entry endpoint', async () => {
  db.prepare('UPDATE guest_policy SET hourly_limit=1').run();
  await start();
  const rejected = await browser().request('/auth/sign-in/anonymous', {});
  expect(rejected.ok).toBe(false);
  expect(db.prepare('SELECT COUNT(*) n FROM guest_libraries').get()).toEqual({ n: 1 });
});
