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
  return betterAuth({
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
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
    rateLimit: { enabled: true },
    advanced: { useSecureCookies: process.env.NODE_ENV === 'production' },
  });
}
