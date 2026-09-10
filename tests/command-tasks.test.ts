import { expect, it, vi } from 'vitest';
import { CommandTasks } from '../src/services/command-tasks';
it('acknowledges activation synchronously, deduplicates one entity and lets another proceed', async () => {
  const tasks = new CommandTasks();
  let release!: (value: string) => void;
  const pending = new Promise<string>((resolve) => {
    release = resolve;
  });
  const work = vi.fn(() => pending);
  const a = tasks.run('a', work);
  const id = tasks.store.getState().a.id;
  expect(tasks.pending('a')).toBe(true);
  expect(tasks.run('a', work)).toBe(a);
  await tasks.run('b', async (progress) => {
    progress('refreshing');
    return 'B';
  });
  expect(tasks.store.getState().b.phase).toBe('accepted');
  expect(tasks.pending('a')).toBe(true);
  release('A');
  expect(await a).toBe('A');
  expect(tasks.store.getState().a).toEqual({ id, phase: 'accepted' });
  expect(work).toHaveBeenCalledOnce();
});
it('retains a failed command’s identity and error, then admits an explicit new activation', async () => {
  const tasks = new CommandTasks();
  await expect(
    tasks.run('a', async () => {
      throw new Error('Unavailable');
    }),
  ).rejects.toThrow('Unavailable');
  const failed = tasks.store.getState().a;
  expect(failed).toMatchObject({ phase: 'failed', error: 'Unavailable' });
  await tasks.run('a', async () => {});
  expect(tasks.store.getState().a.id).not.toBe(failed.id);
  expect(tasks.store.getState().a).toMatchObject({ phase: 'accepted' });
});
