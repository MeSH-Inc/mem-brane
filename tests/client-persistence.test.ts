import { expect, it } from 'vitest';
import { TextSaves } from '../src/services/text-saves';
import { Submission } from '../src/services/submission';
import { ApiError } from '../src/services/api';
import type { BraneState } from '../shared/types/domain';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const state = (version: number, text: string): BraneState => ({
  brane: { id: 'b', title: '', created_at: 0, updated_at: 0 },
  blocks: [
    { id: 'a', origin: 'authored', kind: 'text', version, content: { format: 'text', text } },
  ],
  placements: [],
  runs: [],
  derivations: [],
});
it('keeps acknowledged text when a pre-save GET arrives late', async () => {
  const write = deferred<{ version: number; content: { format: 'text'; text: string } }>();
  const saves = new TextSaves(() => write.promise);
  saves.reconcile(state(0, 'old'));
  const pending = saves.save({ blockId: 'a', version: 0, text: 'saved' });
  write.resolve({ version: 1, content: { format: 'text', text: 'saved' } });
  await pending;
  expect(saves.reconcile(state(0, 'old')).blocks[0]).toMatchObject({
    version: 1,
    content: { format: 'text', text: 'saved' },
  });
  saves.reconcile(state(2, 'remote'));
  saves.acknowledge('a', { version: 1, content: { format: 'text', text: 'saved' } });
  expect(saves.reconcile(state(0, 'old')).blocks[0].content.text).toBe('remote');
});
it('serializes text writes and snapshots, and resumes after a rejected operation', async () => {
  const gate = deferred<void>();
  const order: string[] = [];
  const saves = new TextSaves(async () => ({ version: 1, content: { format: 'text', text: '' } }));
  const first = saves.serialize(['block'], async () => {
    await gate.promise;
    order.push('save');
    throw new Error('conflict');
  });
  const rejected = expect(first).rejects.toThrow('conflict');
  const second = saves.serialize(['block'], async () => {
    order.push('snapshot');
  });
  expect(order).toEqual([]);
  gate.resolve();
  await rejected;
  await second;
  expect(order).toEqual(['save', 'snapshot']);
});
it.each([400, 403, 409, 429])(
  'allows corrected inputs after definite rejection %s',
  async (status) => {
    const submission = new Submission<{ key: string; prompt: string }>();
    await expect(
      submission.send(
        async () => ({ key: 'old', prompt: 'old' }),
        async () => {
          throw new ApiError(status, 'rejected');
        },
      ),
    ).rejects.toThrow();
    expect(submission.state.status).toBe('rejected');
    expect(
      await submission.send(
        async () => ({ key: 'new', prompt: 'corrected' }),
        async () => {},
      ),
    ).toEqual({ request: { key: 'new', prompt: 'corrected' }, receipt: undefined });
  },
);
it.each([new Error('offline'), new ApiError(500, 'unknown'), new ApiError(408, 'timeout')])(
  'reconciles uncertain delivery with the exact original request',
  async (error) => {
    const submission = new Submission<{ key: string; references: string[] }>();
    const request = { key: 'original', references: ['a'] };
    await expect(
      submission.send(
        async () => request,
        async () => {
          throw error;
        },
      ),
    ).rejects.toThrow();
    request.references.push('b');
    const accepted = await submission.send(
      async () => {
        throw new Error('must not prepare again');
      },
      async (retry) => {
        expect(retry).toEqual({ key: 'original', references: ['a'] });
      },
    );
    expect(accepted.request.key).toBe('original');
  },
);
it('prevents a second submit while preparation is in flight', async () => {
  const submission = new Submission<string>();
  const gate = deferred<string>();
  const first = submission.send(
    () => gate.promise,
    async () => {},
  );
  await expect(
    submission.send(
      async () => 'second',
      async () => {},
    ),
  ).rejects.toThrow('in progress');
  gate.resolve('first');
  await first;
});

it('reserves multi-source barriers without blocking unrelated entities', async () => {
  const saves = new TextSaves(async () => ({ version: 1, content: { format: 'text', text: '' } }));
  const gate = deferred<void>();
  const order: string[] = [];
  const first = saves.serialize(['a'], async () => {
    await gate.promise;
    order.push('a');
  });
  const snapshot = saves.serialize(['a', 'b'], async () => {
    order.push('snapshot');
  });
  const b = saves.serialize(['b'], async () => {
    order.push('b');
  });
  await saves.serialize(['c'], async () => {
    order.push('c');
  });
  expect(order).toEqual(['c']);
  gate.resolve();
  await Promise.all([first, snapshot, b]);
  expect(order).toEqual(['c', 'a', 'snapshot', 'b']);
});
it('rebases through own acknowledgements but never an observed remote version', () => {
  const saves = new TextSaves(async () => ({ version: 1, content: { format: 'text', text: '' } }));
  const edit = { blockId: 'a', text: 'Frozen', version: 0 };
  saves.reconcile(state(4, 'remote'));
  expect(saves.afterOwnWrites(edit)).toEqual(edit);
  saves.acknowledge('a', { version: 1, content: { format: 'text', text: 'Earlier own save' } }, 0);
  expect(saves.afterOwnWrites(edit)).toEqual({ ...edit, version: 1 });
});
