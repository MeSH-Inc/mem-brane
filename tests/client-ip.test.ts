import { afterEach, expect, it } from 'vitest';
import { openDatabase, type DB } from '../server/db';
import { createAuth } from '../server/auth';
import { config } from '../server/app/config';

let db: DB | undefined;
const original = config.TRUST_PROXY;
afterEach(() => {
  config.TRUST_PROXY = original;
  db?.close();
  db = undefined;
});

function anonymousSignIn(auth: ReturnType<typeof createAuth>, headers: Record<string, string>) {
  return auth.handler(
    new Request(new URL('/api/auth/sign-in/anonymous', config.APP_ORIGIN), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: config.APP_ORIGIN, ...headers },
      body: '{}',
    }),
  );
}

it('rate-limits by CF-Connecting-IP behind Cloudflare, whatever X-Forwarded-For says', async () => {
  config.TRUST_PROXY = 'cloudflare';
  db = openDatabase(':memory:');
  const auth = createAuth(db);
  // /sign-in/anonymous allows 5 per minute per client.
  for (let i = 0; i < 5; i++) {
    const res = await anonymousSignIn(auth, {
      'cf-connecting-ip': '198.51.100.2',
      'x-forwarded-for': `10.0.0.${i}, 198.51.100.2, 172.18.0.1`,
    });
    expect(res.status).toBe(200);
  }
  const limited = await anonymousSignIn(auth, {
    'cf-connecting-ip': '198.51.100.2',
    'x-forwarded-for': '203.0.113.9, 198.51.100.2, 172.18.0.1',
  });
  expect(limited.status).toBe(429);
  const other = await anonymousSignIn(auth, {
    'cf-connecting-ip': '198.51.100.7',
    'x-forwarded-for': '198.51.100.2, 172.18.0.1',
  });
  expect(other.status).toBe(200);
});
