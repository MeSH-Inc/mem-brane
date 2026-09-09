// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { RequestJournal } from '../src/services/request-journal';
import { Submission } from '../src/services/submission';
import { ApiError } from '../src/services/api';
const journal = (key = 'alice:brane') =>
  new RequestJournal<{ key: string; prompt: string }>(
    key,
    (value) =>
      !!value &&
      typeof value === 'object' &&
      'key' in value &&
      typeof value.key === 'string' &&
      'prompt' in value &&
      typeof value.prompt === 'string',
  );
const original = { key: 'original', prompt: 'Original intent' };
afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});
it('rehydrates immutable uncertain intent and clears it only after acknowledgement', async () => {
  const first = new Submission(journal());
  await expect(
    first.send(
      async () => original,
      async () => {
        throw new Error('lost response');
      },
    ),
  ).rejects.toThrow();
  const second = new Submission(journal());
  expect(second.state.status).toBe('uncertain');
  const prepare = vi.fn();
  expect(
    await second.send(prepare, async (value) => {
      expect(value).toEqual(original);
    }),
  ).toEqual(original);
  expect(prepare).not.toHaveBeenCalled();
  expect(new Submission(journal()).state.status).toBe('idle');
});
it('does not send when persistence fails and remains retryable', async () => {
  const submission = new Submission(journal());
  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota');
  });
  const transport = vi.fn();
  await expect(submission.send(async () => original, transport)).rejects.toThrow('safe retry');
  expect(transport).not.toHaveBeenCalled();
  expect(submission.state.status).toBe('idle');
  storage.mockRestore();
  await submission.send(async () => original, transport);
  expect(transport).toHaveBeenCalledOnce();
});
it('retains the operation if journal clearing fails after server acceptance', async () => {
  const submission = new Submission(journal());
  await expect(
    submission.send(
      async () => original,
      async () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
          throw new Error('quota');
        });
      },
    ),
  ).rejects.toThrow('safe retry');
  expect(submission.state.status).toBe('uncertain');
  vi.restoreAllMocks();
  const restored = new Submission(journal());
  await restored.send(
    async () => {
      throw new Error('must not prepare');
    },
    async (value) => {
      expect(value).toEqual(original);
    },
  );
});
it('clears definite rejections so corrected intent can use a new key after reload', async () => {
  await expect(
    new Submission(journal()).send(
      async () => original,
      async () => {
        throw new ApiError(409, 'conflict');
      },
    ),
  ).rejects.toThrow();
  const restored = new Submission(journal());
  expect(restored.state.status).toBe('idle');
  expect(
    await restored.send(
      async () => ({ key: 'new', prompt: 'Corrected' }),
      async () => {},
    ),
  ).toEqual({ key: 'new', prompt: 'Corrected' });
});
it('isolates identity scopes and blocks malformed recovery rather than silently losing its key', async () => {
  journal().set('run', original);
  expect(journal('bob:brane').get('run')).toBeUndefined();
  expect(journal('alice:other').get('run')).toBeUndefined();
  sessionStorage.setItem('broken', '[1]');
  const transport = vi.fn();
  await expect(
    new Submission(journal('broken')).send(async () => original, transport),
  ).rejects.toThrow('recovery is unavailable');
  expect(transport).not.toHaveBeenCalled();
});
