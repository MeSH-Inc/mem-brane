import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { openDatabase } from '../server/db/index';
import { createBrane, createTextBlock, revisions, uid } from '../server/services/content';
import { submitRun, retryRun } from '../server/services/runs';
import { readInputs } from '../server/services/context-reader';
const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  children.length = 0;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});
function start(path: string, complete = false) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/worker-process.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TEST_DATABASE: path,
      TEST_COMPLETE: complete ? 'yes' : 'no',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.push(child);
  return child;
}
it('SIGKILL preserves checkpoints; restart interrupts instead of re-invoking; explicit retry completes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-brane-crash-'));
  dirs.push(dir);
  const path = join(dir, 'test.sqlite'),
    db = openDatabase(path),
    actor = uid();
  try {
    db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
      actor,
      'Test',
      `${actor}@example.com`,
      0,
      0,
    );
    const brane = createBrane(db, actor),
      block = createTextBlock(db, actor, brane.id),
      limits = {
        models: ['mock'],
        maxTokens: 100,
        userConcurrency: 3,
        maxContextCharacters: 10000,
      };
    const run = submitRun(
        db,
        revisions(db),
        actor,
        {
          braneId: brane.id,
          key: uid(),
          model: 'mock',
          prompt: 'Crash test',
          references: [block.id],
          edits: [],
        },
        limits,
      ),
      frozen = readInputs(db, run.id);
    const first = start(path);
    await expect
      .poll(
        () =>
          (db.prepare('SELECT text FROM run_checkpoints WHERE run_id=?').get(run.id) as any)?.text,
        { timeout: 5000 },
      )
      .toBe('Durable partial output');
    // A healthy heartbeat keeps the lease alive beyond the original acquisition.
    await new Promise((r) => setTimeout(r, 650));
    expect(
      (db.prepare('SELECT lease_until FROM runs WHERE id=?').get(run.id) as any).lease_until,
    ).toBeGreaterThan(Date.now());
    first.kill('SIGKILL');
    await once(first, 'exit');
    const second = start(path, true);
    await expect
      .poll(() => (db.prepare('SELECT status FROM runs WHERE id=?').get(run.id) as any).status, {
        timeout: 5000,
      })
      .toBe('interrupted');
    expect(
      (db.prepare('SELECT count(*) n FROM run_attempts WHERE run_id=?').get(run.id) as any).n,
    ).toBe(1);
    expect(db.prepare('SELECT * FROM run_outputs WHERE run_id=?').get(run.id)).toBeUndefined();
    expect(
      (db.prepare('SELECT status FROM run_costs WHERE run_id=?').get(run.id) as any).status,
    ).toBe('uncertain');
    const retry = retryRun(db, actor, run.id, uid(), limits);
    await expect
      .poll(() => (db.prepare('SELECT status FROM runs WHERE id=?').get(retry.id) as any).status, {
        timeout: 5000,
      })
      .toBe('completed');
    expect(readInputs(db, retry.id).map((i) => i.revision_id)).toEqual(
      frozen.map((i) => i.revision_id),
    );
    second.kill('SIGTERM');
    await once(second, 'exit');
  } finally {
    db.close();
  }
}, 15000);
