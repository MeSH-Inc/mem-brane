import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, networkApi } from '../src/services/transport';
afterEach(() => vi.unstubAllGlobals());
const respond = (status: number, body: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
it('keeps the server error code, retryability and request reference', async () => {
  respond(429, { error: 'Guest workspace limit reached.', code: 'guest_limit', retryable: false });
  const refused = await networkApi('/blocks/text', {}).catch((error) => error);
  expect(refused).toBeInstanceOf(ApiError);
  expect(refused).toMatchObject({ status: 429, code: 'guest_limit', retryable: false });
  respond(500, {
    error: 'An unexpected error occurred',
    code: 'internal',
    retryable: true,
    requestId: '0123456789abcdef',
  });
  const failed = (await networkApi('/branes').catch((error) => error)) as ApiError;
  expect(failed).toMatchObject({
    code: 'internal',
    retryable: true,
    requestId: '0123456789abcdef',
  });
  expect(failed.message).toBe('An unexpected error occurred (reference 01234567)');
});
it('derives a code from the status when the body has none', async () => {
  respond(429, { error: 'Too many requests' });
  expect(await networkApi('/branes').catch((error) => error)).toMatchObject({
    code: 'rate_limited',
    retryable: true,
  });
  respond(409, { code: 'not-a-code', error: 'changed' });
  expect(await networkApi('/branes').catch((error) => error)).toMatchObject({
    code: 'conflict',
    retryable: false,
  });
});
