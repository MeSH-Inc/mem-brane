import { anonymous } from 'better-auth/plugins';
import { claimGuestLibrary } from '../services/guest-claims.js';
import { betterAuth } from 'better-auth';
import { createAuthMiddleware, APIError } from 'better-auth/api';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { DB } from '../db/index.js';
import { config } from '../app/config.js';
export function createAuth(db: DB) {
  if (
    process.env.NODE_ENV === 'production' &&
    (!process.env.BETTER_AUTH_SECRET ||
      process.env.BETTER_AUTH_SECRET.length < 32 ||
      process.env.BETTER_AUTH_SECRET.startsWith('replace-'))
  )
    throw new Error('Set a secure BETTER_AUTH_SECRET');
  const inviteCode = process.env.SIGNUP_INVITE_CODE ?? '';
  if (config.SIGNUP_MODE === 'invite' && inviteCode.length < 32)
    throw new Error('Set SIGNUP_INVITE_CODE to at least 32 random characters');
  const digest = (value: string) => createHash('sha256').update(value).digest();
  db.prepare(
    'UPDATE guest_policy SET enabled=?,lifetime_ms=?,library_limit=?,hourly_limit=? WHERE singleton=1',
  ).run(
    config.GUEST_MODE === 'enabled' ? 1 : 0,
    config.GUEST_LIFETIME_DAYS * 86400000,
    config.GUEST_LIBRARY_LIMIT,
    config.GUEST_HOURLY_LIMIT,
  );
  return betterAuth({
    plugins: [
      anonymous({
        generateName: () => 'Guest',
        disableDeleteAnonymousUser: true,
        onLinkAccount: async ({ anonymousUser, newUser }) => {
          if (newUser.user.isAnonymous) return;
          const guest = db
            .prepare('SELECT id FROM libraries WHERE principal_id=?')
            .get(anonymousUser.user.id) as { id: string } | undefined;
          if (guest) claimGuestLibrary(db, anonymousUser.user.id, newUser.user.id, guest.id);
        },
      }),
    ],
    session: { expiresIn: 30 * 86400 },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/sign-in/anonymous') {
          if (config.GUEST_MODE === 'disabled')
            throw new APIError('FORBIDDEN', { message: 'Guest entry is disabled.' });
          const guests = db
            .prepare(
              'SELECT COUNT(*) n FROM guest_libraries WHERE claimed_by IS NULL AND purged_at IS NULL',
            )
            .get() as { n: number };
          const recent = db
            .prepare('SELECT COUNT(*) n FROM guest_admissions WHERE created_at>?')
            .get(Date.now() - 3600000) as { n: number };
          if (guests.n >= config.GUEST_LIBRARY_LIMIT || recent.n >= config.GUEST_HOURLY_LIMIT)
            throw new APIError('TOO_MANY_REQUESTS', {
              message: 'Guest entry is temporarily full. Please sign in or try again later.',
            });
        }
        if (ctx.path !== '/sign-up/email') return;
        if (config.SIGNUP_MODE === 'closed')
          throw new APIError('FORBIDDEN', { message: 'Account registration is closed.' });
        if (config.SIGNUP_MODE === 'invite') {
          const supplied: unknown = ctx.body?.inviteCode;
          if (
            typeof supplied !== 'string' ||
            supplied.length > 256 ||
            !timingSafeEqual(digest(supplied), digest(inviteCode))
          )
            throw new APIError('FORBIDDEN', { message: 'A valid invitation code is required.' });
        }
      }),
    },
    database: db,
    baseURL: config.APP_ORIGIN,
    secret:
      process.env.BETTER_AUTH_SECRET ??
      'local-development-only-mem-brane-secret-change-in-production',
    trustedOrigins: [config.APP_ORIGIN],
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    rateLimit: { enabled: true, customRules: { '/sign-in/anonymous': { window: 60, max: 5 } } },
    advanced: { useSecureCookies: process.env.NODE_ENV === 'production' },
  });
}
