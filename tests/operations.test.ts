import { it, expect } from 'vitest';
import { DiskMonitor } from '../server/app/disk';
import { maintainHistory } from '../server/services/retention';
import { openDatabase } from '../server/db';
import {
  createBrane,
  revisions,
  uid,
  createBlock,
  updateBlockLiveState,
} from '../server/services/content';
import { submitRun } from '../server/services/runs';
import { RunWorker } from '../server/jobs/worker';
import { EventHub } from '../server/sse/hub';
import { MAX_BRANE_PLACEMENTS, MAX_BLOCK_TEXT_CHARACTERS } from '../shared/limits';

it('pauses on low, failed and stale disk probes; resumes only with headroom', async () => {
  let bytes = 200,
    time = 0,
    broken = false;
  const events: string[] = [];
  const disk = new DiskMonitor(
    ['/db', '/assets'],
    100,
    1000,
    async () => {
      if (broken) throw new Error('Unavailable');
      return { bavail: bytes, bsize: 1 };
    },
    (event) => {
      events.push(event);
    },
    () => time,
  );
  expect(disk.allowsWrites).toBe(false);
  await disk.check();
  expect(disk.allowsWrites).toBe(true);
  bytes = 90;
  await disk.check();
  expect(disk.status).toBe('low');
  broken = true;
  await disk.check();
  expect(disk.status).toBe('unknown');
  broken = false;
  bytes = 110;
  await disk.check();
  expect(disk.allowsWrites).toBe(false);
  bytes = 125;
  await disk.check();
  expect(disk.allowsWrites).toBe(true);
  time = 2001;
  expect(disk.status).toBe('unknown');
  await disk.check();
  expect(disk.allowsWrites).toBe(true);
  expect(events.length).toBeGreaterThan(3);
});
function fixture() {
  const db = openDatabase(':memory:'),
    actor = uid();
  db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
    actor,
    'Test',
    `${actor}@example.com`,
    0,
    0,
  );
  return { db, actor, brane: createBrane(db, actor).id };
}
it('enforces aggregate placement and content limits including multibyte text', () => {
  const { db, actor, brane } = fixture();
  try {
    const block = createBlock(db, actor, 'text', { format: 'text', text: '' }, brane);
    expect(() =>
      updateBlockLiveState(db, actor, {
        blockId: block.id,
        version: 0,
        text: 'x'.repeat(MAX_BLOCK_TEXT_CHARACTERS + 1),
      }),
    ).toThrow('limit');
    expect(() =>
      updateBlockLiveState(db, actor, { blockId: block.id, version: 0, text: '界'.repeat(15000) }),
    ).toThrow('byte limit');
    for (let i = 1; i < MAX_BRANE_PLACEMENTS; i++)
      createBlock(db, actor, 'text', { format: 'text', text: '' }, brane);
    expect(() => createBlock(db, actor, 'text', { format: 'text', text: '' }, brane)).toThrow(
      'capacity',
    );
  } finally {
    db.close();
  }
});
it('retains active/uncertain/mismatched history and removes only redundant settled checkpoints', async () => {
  const { db, actor, brane } = fixture();
  const limits = {
    models: ['mock'],
    maxTokens: 10,
    userConcurrency: 10,
    maxContextCharacters: 10000,
  };
  const submit = () =>
    submitRun(
      db,
      revisions(db),
      actor,
      { braneId: brane, key: uid(), model: 'mock', prompt: 'Test', references: [], edits: [] },
      limits,
    );
  const worker = new RunWorker(db, new EventHub(), async () => ({ text: 'Final' }), {
    concurrency: 5,
    leaseMs: 1000,
    checkpointMs: 10,
    checkpointCharacters: 10,
  });
  try {
    const runs = Array.from({ length: 4 }, submit);
    worker.tick();
    await expect
      .poll(
        () =>
          (
            db.prepare("SELECT count(*) n FROM runs WHERE status='completed'").get() as {
              n: number;
            }
          ).n,
      )
      .toBe(4);
    await worker.stop();
    db.prepare("UPDATE spend_commitments SET status='uncertain' WHERE run_id=?").run(runs[1].id);
    db.prepare("UPDATE run_checkpoints SET text='Different partial' WHERE run_id=?").run(
      runs[2].id,
    );
    const queued = submit();
    db.prepare('INSERT INTO run_checkpoints VALUES (?,?,?)').run(queued.id, 'Active partial', 0);
    const time = Date.now() + 8 * 86400000;
    expect(
      maintainHistory(db, { completedCheckpointDays: 7, batchSize: 1 }, time).checkpoints,
    ).toBe(1);
    expect(
      maintainHistory(db, { completedCheckpointDays: 7, batchSize: 1 }, time).checkpoints,
    ).toBe(1);
    expect(
      maintainHistory(db, { completedCheckpointDays: 7, batchSize: 100 }, time).checkpoints,
    ).toBe(0);
    expect((db.prepare('SELECT count(*) n FROM run_checkpoints').get() as { n: number }).n).toBe(3);
    expect((db.prepare('SELECT count(*) n FROM run_outputs').get() as { n: number }).n).toBe(4);
    expect((db.prepare('SELECT count(*) n FROM context_entries').get() as { n: number }).n).toBe(5);
  } finally {
    await worker.stop();
    db.close();
  }
});

it('leaves work queued when admission is paused and resumes after recovery', async () => {
  const { db, actor, brane } = fixture();
  let allowed = false;
  const run = submitRun(
    db,
    revisions(db),
    actor,
    { braneId: brane, key: uid(), model: 'mock', prompt: 'Test', references: [], edits: [] },
    { models: ['mock'], maxTokens: 10, userConcurrency: 3, maxContextCharacters: 1000 },
  );
  const worker = new RunWorker(db, new EventHub(), async () => ({ text: 'Recovered' }), {
    concurrency: 1,
    leaseMs: 1000,
    checkpointMs: 10,
    checkpointCharacters: 10,
    canClaim: () => allowed,
  });
  try {
    worker.tick();
    expect(
      (db.prepare('SELECT status FROM runs WHERE id=?').get(run.id) as { status: string }).status,
    ).toBe('queued');
    allowed = true;
    worker.tick();
    await expect
      .poll(
        () =>
          (db.prepare('SELECT status FROM runs WHERE id=?').get(run.id) as { status: string })
            .status,
      )
      .toBe('completed');
  } finally {
    await worker.stop();
    db.close();
  }
});

it('cleans expired authentication rows in bounded batches without deleting live sessions', () => {
  const { db, actor } = fixture();
  try {
    for (const expiry of [10, 20, 30])
      db.prepare(
        'INSERT INTO session (id,token,expiresAt,createdAt,updatedAt,userId) VALUES (?,?,?,?,?,?)',
      ).run(uid(), uid(), expiry, 0, 0, actor);
    expect(maintainHistory(db, { completedCheckpointDays: 7, batchSize: 1 }, 25).sessions).toBe(1);
    expect(maintainHistory(db, { completedCheckpointDays: 7, batchSize: 1 }, 25).sessions).toBe(1);
    expect(maintainHistory(db, { completedCheckpointDays: 7, batchSize: 1 }, 25).sessions).toBe(0);
    expect(
      (db.prepare('SELECT expiresAt FROM session').get() as { expiresAt: number }).expiresAt,
    ).toBe(30);
  } finally {
    db.close();
  }
});
