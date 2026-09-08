import { expect, it, vi } from 'vitest';
import { PlacementSaves } from '../src/services/placement-saves';
import type { Geometry, Placement } from '../shared/types/domain';
const base: Placement = {
  id: 'p',
  brane_id: 'brane',
  block_id: 'block',
  x: 0,
  y: 0,
  width: 320,
  height: 220,
  z_index: 0,
  version: 0,
};
const move = (x: number): Geometry => ({ x, y: 0, width: 320, height: 220 });
const saved = (x: number, version: number): Placement => ({ ...base, ...move(x), version });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
it('serializes writes and coalesces intermediate moves without flashing old acknowledgements', async () => {
  const first = deferred<Placement>(),
    last = deferred<Placement>();
  const write = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
  const queue = new PlacementSaves({ write, read: vi.fn() });
  const a = queue.save(base, move(10)),
    b = queue.save(base, move(20)),
    c = queue.save(base, move(30));
  expect(write).toHaveBeenCalledTimes(1);
  expect(queue.project([base])[0].x).toBe(30);
  first.resolve(saved(10, 1));
  await a;
  expect(write).toHaveBeenNthCalledWith(2, 'p', move(30), 1);
  expect(queue.project([base])[0].x).toBe(30);
  last.resolve(saved(30, 2));
  await Promise.all([b, c]);
  expect(queue.project([base])[0]).toEqual(saved(30, 2));
  expect(queue.hasPending()).toBe(false);
});
it('runs independent placements concurrently', async () => {
  const write = vi.fn(async (id: string, g: Geometry, version: number) => ({
    ...base,
    ...g,
    id,
    version: version + 1,
  }));
  const queue = new PlacementSaves({ write, read: vi.fn() });
  await Promise.all([queue.save(base, move(10)), queue.save({ ...base, id: 'other' }, move(20))]);
  expect(write).toHaveBeenCalledTimes(2);
  expect(queue.project([base, { ...base, id: 'other' }]).map((p) => p.x)).toEqual([10, 20]);
});
it('an earlier failure preserves the newest intent and pauses the lane', async () => {
  const request = deferred<Placement>();
  const write = vi.fn(() => request.promise);
  const queue = new PlacementSaves({ write, read: vi.fn() });
  const a = queue.save(base, move(10)),
    b = queue.save(base, move(20));
  const rejected = Promise.allSettled([a, b]);
  request.reject(new Error('Conflict'));
  await rejected;
  queue.observe([saved(50, 1)]);
  expect(queue.project([saved(50, 1)])[0].x).toBe(20);
  expect(write).toHaveBeenCalledTimes(1);
  expect(queue.failures()[0].message).toBe('Conflict');
  await expect(queue.save(base, move(30))).rejects.toThrow('Conflict');
  expect(queue.project([base])[0].x).toBe(30);
  expect(write).toHaveBeenCalledTimes(1);
});
it('does not silently rebase queued moves after a newer remote refresh', async () => {
  const request = deferred<Placement>();
  const write = vi
    .fn()
    .mockReturnValueOnce(request.promise)
    .mockRejectedValueOnce(new Error('Conflict'));
  const queue = new PlacementSaves({ write, read: vi.fn() });
  const a = queue.save(base, move(10)),
    b = queue.save(base, move(20));
  const result = Promise.allSettled([a, b]);
  queue.observe([saved(99, 2)]);
  request.resolve(saved(10, 1));
  await result;
  expect(write).toHaveBeenNthCalledWith(2, 'p', move(20), 1);
  expect(queue.failures()).toHaveLength(1);
  expect(queue.project([base])[0]).toMatchObject({ x: 20, version: 2 });
});
it('ignores old refreshes after a successful save', async () => {
  const queue = new PlacementSaves({ write: vi.fn(async () => saved(20, 2)), read: vi.fn() });
  await queue.save(base, move(20));
  queue.observe([saved(10, 1)]);
  expect(queue.project([saved(10, 1)])[0]).toEqual(saved(20, 2));
});
it('explicit retry reads the latest version and saves the latest local intent', async () => {
  const write = vi
    .fn()
    .mockRejectedValueOnce(new Error('Conflict'))
    .mockResolvedValueOnce(saved(30, 6));
  const read = vi.fn(async () => saved(99, 5));
  const queue = new PlacementSaves({ write, read });
  await expect(queue.save(base, move(20))).rejects.toThrow();
  await expect(queue.save(base, move(30))).rejects.toThrow();
  await queue.retry('p');
  expect(read).toHaveBeenCalledWith('p');
  expect(write).toHaveBeenLastCalledWith('p', move(30), 5);
  expect(queue.project([base])[0]).toEqual(saved(30, 6));
  expect(queue.failures()).toEqual([]);
});
it('discard reloads authoritative state even if the failed request actually committed', async () => {
  const queue = new PlacementSaves({
    write: vi.fn().mockRejectedValue(new Error('Lost response')),
    read: vi.fn(async () => saved(10, 1)),
  });
  await expect(queue.save(base, move(10))).rejects.toThrow();
  await queue.discard('p');
  expect(queue.project([base])[0]).toEqual(saved(10, 1));
  expect(queue.hasPending()).toBe(false);
});
it('a delayed discard cannot erase a newer move and failed reads retain the intent', async () => {
  const read = deferred<Placement>();
  const queue = new PlacementSaves({
    write: vi.fn().mockRejectedValue(new Error('Offline')),
    read: vi.fn(() => read.promise),
  });
  await expect(queue.save(base, move(10))).rejects.toThrow();
  const discard = queue.discard('p');
  await expect(queue.save(base, move(20))).rejects.toThrow();
  read.resolve(saved(90, 1));
  await discard;
  expect(queue.project([base])[0].x).toBe(20);
  expect(queue.failures()).toHaveLength(1);
  const offline = new PlacementSaves({
    write: vi.fn().mockRejectedValue(new Error('Offline')),
    read: vi.fn().mockRejectedValue(new Error('Offline')),
  });
  await expect(offline.save(base, move(20))).rejects.toThrow();
  await offline.discard('p');
  expect(offline.project([base])[0].x).toBe(20);
  expect(offline.hasPending()).toBe(true);
});

it('retains version watermarks for placements changed remotely before any local move', () => {
  const queue = new PlacementSaves({ write: vi.fn(), read: vi.fn() });
  queue.observe([saved(20, 2)]);
  queue.observe([saved(10, 1)]);
  expect(queue.project([saved(10, 1)])[0]).toEqual(saved(20, 2));
});
it('Save brane waits for all placement lanes and reports a failure', async () => {
  const request = deferred<Placement>();
  const queue = new PlacementSaves({ write: vi.fn(() => request.promise), read: vi.fn() });
  const save = queue.save(base, move(10));
  let finished = false;
  const flush = queue.flush().then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  request.resolve(saved(10, 1));
  await Promise.all([save, flush]);
  expect(finished).toBe(true);
  const failed = new PlacementSaves({
    write: vi.fn().mockRejectedValue(new Error('Conflict')),
    read: vi.fn(),
  });
  await expect(failed.save(base, move(10))).rejects.toThrow();
  await expect(failed.flush()).rejects.toThrow('Conflict');
});

it('placement removal cancels queued work and ignores a late acknowledgement', async () => {
  const request = deferred<Placement>();
  const write = vi.fn(() => request.promise);
  const queue = new PlacementSaves({ write, read: vi.fn() });
  const a = queue.save(base, move(10)),
    b = queue.save(base, move(20));
  const rejected = Promise.allSettled([a, b]);
  const flushed = queue.flush();
  queue.observe([]);
  await flushed;
  expect((await rejected).every((result) => result.status === 'rejected')).toBe(true);
  request.resolve(saved(10, 1));
  await Promise.resolve();
  expect(write).toHaveBeenCalledTimes(1);
  expect(queue.hasPending()).toBe(false);
  expect(queue.failures()).toEqual([]);
  expect(queue.project([])).toEqual([]);
});
