import { betterAuth } from 'better-auth';
import type { DB } from '../db/index.js';
import { config } from '../app/config.js';
export function createAuth(db: DB) {
  if (
    process.env.NODE_ENV === 'production' &&
    (!process.env.BETTER_AUTH_SECRET || process.env.BETTER_AUTH_SECRET.startsWith('replace-'))
  )
    throw new Error('Set a secure BETTER_AUTH_SECRET');
  return betterAuth({
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
