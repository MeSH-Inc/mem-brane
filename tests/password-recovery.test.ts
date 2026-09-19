import { expect, it } from 'vitest';
import { openDatabase } from '../server/db';
import { createAuth } from '../server/auth';
import { config } from '../server/app/config';
import type { BetterAuthOptions } from 'better-auth';

it('queues recovery without enumeration, expires tokens, rejects replay and revokes sessions', async () => {
  const db = openDatabase(':memory:');
  const auth = createAuth(db, true);
  (auth.options as BetterAuthOptions).rateLimit = { enabled: false };
  const post = (path: string, body: unknown) =>
    auth.handler(
      new Request(`${config.APP_ORIGIN}/api/auth/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: config.APP_ORIGIN },
        body: JSON.stringify(body),
      }),
    );
  try {
    const email = 'recovery@example.com';
    expect(
      (await post('sign-up/email', { email, name: 'Recovery', password: 'old-long-password' }))
        .status,
    ).toBe(200);
    expect((db.prepare('SELECT count(*) n FROM session').get() as { n: number }).n).toBeGreaterThan(
      0,
    );
    const known = await post('request-password-reset', { email });
    const unknown = await post('request-password-reset', { email: 'unknown@example.com' });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await known.json()).toEqual(await unknown.json());
    const rows = db.prepare('SELECT body,expires_at FROM mail_outbox').all() as {
      body: string;
      expires_at: number;
    }[];
    expect(rows).toHaveLength(1);
    const link = rows[0].body.split('\n\n')[1];
    expect(new URL(link).origin).toBe(config.APP_ORIGIN);
    expect(new URL(link).search).toBe('');
    const token = new URLSearchParams(new URL(link).hash.slice(1)).get('token');
    expect(rows[0].expires_at - Date.now()).toBeLessThanOrEqual(900000);
    expect((await post('reset-password', { token, newPassword: 'new-long-password' })).status).toBe(
      200,
    );
    expect(db.prepare('SELECT count(*) n FROM session').get()).toEqual({ n: 0 });
    expect((await post('reset-password', { token, newPassword: 'another-password' })).status).toBe(
      400,
    );
    expect((await post('sign-in/email', { email, password: 'old-long-password' })).status).not.toBe(
      200,
    );
    expect((await post('sign-in/email', { email, password: 'new-long-password' })).status).toBe(
      200,
    );
    await post('request-password-reset', { email });
    const second = (
      db.prepare('SELECT body FROM mail_outbox ORDER BY rowid DESC LIMIT 1').get() as {
        body: string;
      }
    ).body;
    const expiredToken = new URLSearchParams(new URL(second.split('\n\n')[1]).hash.slice(1)).get(
      'token',
    );
    db.prepare('UPDATE verification SET expiresAt=?').run(0);
    expect(
      (await post('reset-password', { token: expiredToken, newPassword: 'expired-password' }))
        .status,
    ).toBe(400);
    expect(
      (
        await post('request-password-reset', {
          email,
          redirectTo: 'https://attacker.example/reset',
        })
      ).status,
    ).toBe(403);
  } finally {
    db.close();
  }
});
it('does not expose recovery when mail is unconfigured', async () => {
  const db = openDatabase(':memory:');
  try {
    const auth = createAuth(db, false);
    expect(auth.options.emailAndPassword?.sendResetPassword).toBeUndefined();
    await expect(
      auth.api.requestPasswordReset({ body: { email: 'a@example.com' } }),
    ).rejects.toThrow();
    expect(db.prepare('SELECT count(*) n FROM mail_outbox').get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});
