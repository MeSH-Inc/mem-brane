import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
// One bounded subprocess keeps backup compression off the API event loop.
export class Backups {
  private timer?: ReturnType<typeof setInterval>;
  private child?: ChildProcess;
  private completion?: Promise<unknown>;
  start() {
    this.run();
    this.timer = setInterval(() => this.run(), 3600000);
    this.timer.unref();
  }
  private run() {
    if (this.child) return;
    const child = spawn(process.execPath, ['dist-ops/backup-remote.js'], {
      stdio: 'inherit',
      timeout: 300000,
      killSignal: 'SIGTERM',
    });
    this.child = child;
    this.completion = once(child, 'exit')
      .then(([code]) => {
        if (code !== 0) console.error(JSON.stringify({ event: 'backup_job_failed', code }));
      })
      .catch(() => console.error(JSON.stringify({ event: 'backup_job_failed' })))
      .finally(() => {
        this.child = undefined;
      });
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.child?.kill('SIGTERM');
    await this.completion;
  }
}
