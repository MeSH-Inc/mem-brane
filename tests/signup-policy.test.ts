import { afterEach, expect, it, vi } from 'vitest';
import type { BetterAuthOptions } from 'better-auth';
import { openDatabase } from '../server/db';
import { createAuth } from '../server/auth';
import { config } from '../server/app/config';
const originalMode = config.SIGNUP_MODE;
const inviteCode = 'test-invitation-code-with-at-least-32-characters';
afterEach(() => {
  config.SIGNUP_MODE = originalMode;
  vi.unstubAllEnvs();
});
it('rejects missing, malformed and wrong invites before creating users; accepts a valid invite', async () => {
  config.SIGNUP_MODE = 'invite';
  vi.stubEnv('SIGNUP_INVITE_CODE', inviteCode);
  const db = openDatabase(':memory:');
  try {
    const auth = createAuth(db);
    // Exercise every invitation branch independently of the HTTP burst limiter.
    const options: BetterAuthOptions = auth.options;
    options.rateLimit = { enabled: false };
    const signup = (code: unknown) =>
      auth.handler(
        new Request(`${config.APP_ORIGIN}/api/auth/sign-up/email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: config.APP_ORIGIN },
          body: JSON.stringify({
            name: 'Private launch',
            email: 'invite@example.com',
            password: 'test-invitation-password',
            inviteCode: code,
          }),
        }),
      );
    for (const code of [undefined, '', {}, 'wrong', 'x'.repeat(257)]) {
      expect((await signup(code)).status).toBe(403);
      expect(db.prepare('SELECT COUNT(*) n FROM user').get()).toEqual({ n: 0 });
    }
    expect((await signup(inviteCode)).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) n FROM user').get()).toEqual({ n: 1 });
    const login = await auth.api.signInEmail({
      body: { email: 'invite@example.com', password: 'test-invitation-password' },
    });
    expect(login.user.email).toBe('invite@example.com');
  } finally {
    db.close();
  }
});
it('closed registration also rejects direct server signup calls', async () => {
  config.SIGNUP_MODE = 'closed';
  const db = openDatabase(':memory:');
  try {
    await expect(
      createAuth(db).api.signUpEmail({
        body: { name: 'Blocked', email: 'closed@example.com', password: 'test-closed-password' },
      }),
    ).rejects.toThrow('Account registration is closed');
    expect(db.prepare('SELECT COUNT(*) n FROM user').get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});
it('fails startup when invite mode has no usable secret', () => {
  config.SIGNUP_MODE = 'invite';
  vi.stubEnv('SIGNUP_INVITE_CODE', 'short');
  const db = openDatabase(':memory:');
  try {
    expect(() => createAuth(db)).toThrow('SIGNUP_INVITE_CODE');
  } finally {
    db.close();
  }
});
