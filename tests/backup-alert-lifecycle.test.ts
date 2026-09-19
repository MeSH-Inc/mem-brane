import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { Backups } from '../server/app/backups';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
function subprocess() {
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn(() => {
      child.emit('exit', null, 'SIGTERM');
      return true;
    }),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return child;
}
it.each([0, 1, null])('reports backup process exit %s exactly once', async (code) => {
  const child = subprocess();
  const report = vi.fn();
  const backups = new Backups(report);
  try {
    backups.start();
    child.emit('exit', code);
    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
    expect(report).toHaveBeenCalledWith(code === 0);
  } finally {
    await backups.stop();
  }
});
it('reports spawn failure but suppresses intentional shutdown alerts', async () => {
  const child = subprocess();
  const report = vi.fn();
  const backups = new Backups(report);
  backups.start();
  child.emit('error', new Error('spawn failed'));
  await vi.waitFor(() => expect(report).toHaveBeenCalledWith(false));
  await backups.stop();
  const shutdownChild = subprocess();
  report.mockClear();
  const shuttingDown = new Backups(report);
  shuttingDown.start();
  await shuttingDown.stop();
  expect(shutdownChild.kill).toHaveBeenCalledWith('SIGTERM');
  expect(report).not.toHaveBeenCalled();
});
it('isolates a broken alert queue from the backup result', async () => {
  const child = subprocess();
  const report = vi.fn(() => {
    throw new Error('private database detail');
  });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const backups = new Backups(report);
  try {
    backups.start();
    child.emit('exit', 0);
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'backup_alert_queue_failed' })),
    );
    expect(report).toHaveBeenCalledExactlyOnceWith(true);
    expect(log).toHaveBeenCalledOnce();
  } finally {
    await backups.stop();
  }
});
