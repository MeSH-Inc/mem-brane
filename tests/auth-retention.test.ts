import { expect, it, vi } from 'vitest';
import type { BetterAuthOptions } from 'better-auth';
import { createAuth } from '../server/auth';
import { config } from '../server/app/config';
import { openDatabase } from '../server/db';
import { maintainHistory } from '../server/services/retention';

it('reclaims real expired sessions and recovery tokens in bounded batches while preserving live authentication', async () => {
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
  const register = async (email: string) => {
    const response = await post('sign-up/email', {
      email,
      name: 'Retention',
      password: 'retention-test-password',
    });
    expect(response.status).toBe(200);
    expect((await post('request-password-reset', { email })).status).toBe(200);
    const { user } = (await response.json()) as { user: { id: string } };
    return {
      email,
      userId: user.id,
      cookie: response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; '),
    };
  };
  const start = Date.UTC(2026, 0, 1);
  const day = 86400000;
  const policy = { completedCheckpointDays: 7, batchSize: 1 };
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(start);
    const oldest = await register('oldest@example.com');
    vi.setSystemTime(start + day);
    const second = await register('second@example.com');
    vi.setSystemTime(start + 32 * day);
    const live = await register('live@example.com');

    // These dates come from Better Auth's SQLite adapter, not a hand-written fixture.
    const session = db.prepare('SELECT expiresAt FROM session WHERE userId=?').get(oldest.userId);
    const token = db.prepare('SELECT expiresAt FROM verification WHERE value=?').get(oldest.userId);
    expect(session).toEqual({ expiresAt: new Date(start + 30 * day).toISOString() });
    expect(token).toEqual({ expiresAt: new Date(start + 900000).toISOString() });
    expect(db.prepare('SELECT count(*) n FROM session').get()).toEqual({ n: 3 });
    expect(db.prepare('SELECT count(*) n FROM verification').get()).toEqual({ n: 3 });

    expect(maintainHistory(db, policy)).toEqual({ checkpoints: 0, sessions: 1, verifications: 1 });
    expect(db.prepare('SELECT 1 FROM session WHERE userId=?').get(oldest.userId)).toBeUndefined();
    expect(
      db.prepare('SELECT 1 FROM verification WHERE value=?').get(oldest.userId),
    ).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM session WHERE userId=?').get(second.userId)).toBeDefined();
    expect(db.prepare('SELECT 1 FROM verification WHERE value=?').get(second.userId)).toBeDefined();
    expect(maintainHistory(db, policy)).toEqual({ checkpoints: 0, sessions: 1, verifications: 1 });
    expect(maintainHistory(db, policy)).toEqual({ checkpoints: 0, sessions: 0, verifications: 0 });
    expect(db.prepare('SELECT userId FROM session').all()).toEqual([{ userId: live.userId }]);
    expect(db.prepare('SELECT value FROM verification').all()).toEqual([{ value: live.userId }]);

    const liveSession = await auth.handler(
      new Request(`${config.APP_ORIGIN}/api/auth/get-session`, {
        headers: { cookie: live.cookie },
      }),
    );
    expect(liveSession.status).toBe(200);
    expect(await liveSession.json()).toMatchObject({ user: { id: live.userId } });
    const mail = db.prepare('SELECT body FROM mail_outbox WHERE recipient=?').get(live.email) as {
      body: string;
    };
    const resetToken = new URLSearchParams(new URL(mail.body.split('\n\n')[1]).hash.slice(1)).get(
      'token',
    );
    expect(
      (await post('reset-password', { token: resetToken, newPassword: 'new-retention-password' }))
        .status,
    ).toBe(200);
    expect(
      (await post('sign-in/email', { email: live.email, password: 'new-retention-password' }))
        .status,
    ).toBe(200);
  } finally {
    vi.useRealTimers();
    db.close();
  }
});
