import { describe, expect, it, vi } from 'vitest';
import {
  boundedBody,
  isPublicAddress,
  validateDestination,
  fetchWebpage,
} from '../server/ingestion/webpage';
describe('webpage ingress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
  ])('blocks private/reserved %s', (ip) => expect(isPublicAddress(ip)).toBe(false));
  it('allows public addresses and pins the resolved address', async () => {
    expect(isPublicAddress('1.1.1.1')).toBe(true);
    const result = await validateDestination('https://example.com', async () => [
      { address: '1.1.1.1', family: 4 },
    ]);
    expect(result.address.address).toBe('1.1.1.1');
  });
  it('rejects mixed public/private DNS answers', async () => {
    await expect(
      validateDestination('https://example.com', async () => [
        { address: '1.1.1.1', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]),
    ).rejects.toThrow('Private');
  });
  it.each([
    'file:///etc/passwd',
    'http://localhost',
    'http://127.1',
    'http://2130706433',
    'http://[::1]',
    'https://user:password@example.com',
    'http://example.com:3001',
  ])('rejects unsafe URL %s', async (url) => {
    await expect(validateDestination(url)).rejects.toThrow();
  });
  it('validates destinations again for a redirect', async () => {
    const initial = await validateDestination('https://example.com', async () => [
      { address: '1.1.1.1', family: 4 },
    ]);
    const redirect = new URL('http://169.254.169.254/latest/meta-data', initial.url);
    await expect(validateDestination(redirect.href)).rejects.toThrow('Private');
  });
  it('bounds streamed content regardless of content-length', async () => {
    async function* chunks() {
      yield new Uint8Array(8);
      yield new Uint8Array(8);
    }
    await expect(boundedBody(chunks(), 10)).rejects.toThrow('size limit');
    expect(await boundedBody(chunks(), 16)).toHaveLength(16);
  });
});
it('actual fetch loop rejects private redirects before making a second request', async () => {
  const fetch = vi.fn(
    async () =>
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/secrets' } }),
  );
  await expect(
    fetchWebpage('https://example.com', 1000, AbortSignal.timeout(1000), {
      resolve: async () => [{ address: '1.1.1.1', family: 4 }],
      fetch: fetch as any,
    }),
  ).rejects.toThrow('Private');
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('actual fetch loop bounds response content and extracts inert text', async () => {
  const resolve = async () => [{ address: '1.1.1.1', family: 4 }];
  const fetch = async () =>
    new Response('<script>bad()</script><p>Useful text</p>', {
      headers: { 'content-type': 'text/html' },
    });
  expect(
    (
      await fetchWebpage('https://example.com', 1000, AbortSignal.timeout(1000), {
        resolve,
        fetch: fetch as any,
      })
    ).text,
  ).toBe('Useful text');
  await expect(
    fetchWebpage('https://example.com', 5, AbortSignal.timeout(1000), {
      resolve,
      fetch: fetch as any,
    }),
  ).rejects.toThrow('size limit');
});

it('local object storage round-trips binary bytes and rejects path traversal', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  const { FileAssetStore } = await import('../server/storage/assets');
  const directory = await mkdtemp(join(tmpdir(), 'mem-brane-assets-'));
  try {
    const store = new FileAssetStore(directory),
      key = randomUUID(),
      bytes = new Uint8Array([1, 2, 3]);
    await store.put(key, bytes);
    expect(new Uint8Array(await store.get(key))).toEqual(bytes);
    await expect(store.get('../secrets')).rejects.toThrow('Invalid asset key');
    await store.delete(key);
    await expect(store.get(key)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
