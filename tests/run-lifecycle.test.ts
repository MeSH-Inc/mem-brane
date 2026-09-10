import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDatabase, type DB } from '../server/db/index';
import { createBrane, revisions, uid } from '../server/services/content';
import { submitRun, readStoredRun } from '../server/services/runs';
import {
  cancelRun,
  claimRun,
  startAttempt,
  renewAttempt,
  saveCheckpoint,
  completeAttempt,
  stopAttempt,
  recoverStale,
} from '../server/services/run-lifecycle';
let db: DB, actor: string, id: string;
beforeEach(() => {
  db = openDatabase(':memory:');
  actor = uid();
  db.prepare('INSERT INTO "user" (id,name,email,createdAt,updatedAt) VALUES (?,?,?,?,?)').run(
    actor,
    'test',
    `${actor}@example.com`,
    0,
    0,
  );
  id = submitRun(
    db,
    revisions(db),
    actor,
    {
      braneId: createBrane(db, actor).id,
      key: uid(),
      model: 'mock',
      prompt: 'Test',
      references: [],
      edits: [],
    },
    { models: ['mock'], maxTokens: 100, userConcurrency: 10, maxContextCharacters: 100000 },
  ).id;
});
afterEach(() => db.close());
function start() {
  expect(claimRun(db, 'worker', 100, 0)?.id).toBe(id);
  return startAttempt(db, id, 'worker', 1)!;
}
function cost() {
  return db.prepare('SELECT status FROM spend_commitments WHERE run_id=?').get(id);
}
function attempt() {
  return db.prepare('SELECT outcome,finished_at FROM run_attempts WHERE run_id=?').get(id);
}

it.each(['queued', 'claimed'])(
  'cancels %s without an attempt and releases reservation',
  (stage) => {
    if (stage === 'claimed') claimRun(db, 'worker', 100, 0);
    cancelRun(db, actor, id, 2);
    expect(startAttempt(db, id, 'worker', 3)).toBeNull();
    expect(readStoredRun(db, id)).toMatchObject({
      status: 'cancelled',
      lease_owner: null,
      lease_until: null,
      finished_at: 2,
    });
    expect(attempt()).toBeUndefined();
    expect(cost()).toEqual({ status: 'released' });
  },
);
it.each([false, true])(
  'cancellation during execution preserves partial output (checkpoint=%s)',
  (saved) => {
    const token = start();
    if (saved) saveCheckpoint(db, token, 'partial', 2);
    cancelRun(db, actor, id, 3);
    expect(completeAttempt(db, token, { text: 'late' }, 4)).toBe(false);
    expect(renewAttempt(db, token, 100, 4)).toBe(false);
    expect(stopAttempt(db, token, 'partial', 'failed', 4)).toBe('cancelled');
    expect(attempt()).toEqual({ outcome: 'cancelled', finished_at: 4 });
    expect(cost()).toEqual({ status: 'uncertain' });
    expect(db.prepare('SELECT text FROM run_checkpoints').get()).toEqual({ text: 'partial' });
    expect(db.prepare('SELECT * FROM run_outputs').all()).toEqual([]);
  },
);
it('requeues an expired claim without charging or creating an attempt', () => {
  claimRun(db, 'old', 100, 0);
  recoverStale(db, 100);
  expect(readStoredRun(db, id).status).toBe('queued');
  expect(cost()).toEqual({ status: 'reserved' });
  expect(startAttempt(db, id, 'old', 101)).toBeNull();
  expect(claimRun(db, 'new', 100, 101)?.id).toBe(id);
});
it.each(['running', 'checkpointed', 'cancel_requested'])(
  'expiry fences every write in %s',
  (stage) => {
    const token = start();
    if (stage !== 'running') saveCheckpoint(db, token, 'saved', 2);
    if (stage === 'cancel_requested') cancelRun(db, actor, id, 3);
    expect(renewAttempt(db, token, 100, 100)).toBe(false);
    expect(saveCheckpoint(db, token, 'stale', 100)).toBe(false);
    expect(completeAttempt(db, token, { text: 'stale' }, 100)).toBe(false);
    expect(stopAttempt(db, token, 'stale', 'failed', 100)).toBeNull();
    recoverStale(db, 100);
    const status = stage === 'cancel_requested' ? 'cancelled' : 'interrupted';
    expect(readStoredRun(db, id)).toMatchObject({ status, lease_owner: null, finished_at: 100 });
    expect(attempt()).toEqual({ outcome: status, finished_at: 100 });
    expect(cost()).toEqual({ status: 'uncertain' });
    expect(db.prepare('SELECT text FROM run_checkpoints').get()).toEqual(
      stage === 'running' ? undefined : { text: 'saved' },
    );
    expect(recoverStale(db, 101)).toEqual([]);
  },
);
it.each(['workerId', 'attemptId'] as const)('rejects mismatched %s', (field) => {
  const token = { ...start(), [field]: 'wrong' };
  expect(renewAttempt(db, token, 100, 2)).toBe(false);
  expect(saveCheckpoint(db, token, 'wrong', 2)).toBe(false);
  expect(completeAttempt(db, token, { text: 'wrong' }, 2)).toBe(false);
  expect(stopAttempt(db, token, 'wrong', 'preflight', 2)).toBeNull();
  expect(readStoredRun(db, id).status).toBe('running');
  expect(cost()).toEqual({ status: 'reserved' });
});
it.each(['preflight', 'failed', 'shutdown'] as const)(
  'stops %s with consistent accounting and attempt outcome',
  (reason) => {
    const token = start();
    const status = reason === 'shutdown' ? 'interrupted' : 'failed';
    expect(stopAttempt(db, token, 'partial', reason, 2)).toBe(status);
    expect(attempt()).toEqual({ outcome: status, finished_at: 2 });
    expect(cost()).toEqual({ status: reason === 'preflight' ? 'released' : 'uncertain' });
    expect(stopAttempt(db, token, 'late', reason, 3)).toBeNull();
  },
);
it('commits output, attempt, and accounting together and ignores late cancellation', () => {
  const token = start();
  expect(completeAttempt(db, token, { text: 'done' }, 2)).toBe(true);
  cancelRun(db, actor, id, 3);
  expect(readStoredRun(db, id).status).toBe('completed');
  expect(attempt()).toEqual({ outcome: 'completed', finished_at: 2 });
  expect(cost()).toEqual({ status: 'confirmed' });
  expect(completeAttempt(db, token, { text: 'duplicate' }, 4)).toBe(false);
  expect(db.prepare('SELECT * FROM run_outputs').all()).toHaveLength(1);
});
it.each(['complete', 'stop', 'cancel', 'expire'])(
  'rolls back %s if accounting fails',
  (operation) => {
    const token = operation === 'cancel' ? null : start();
    db.exec(
      "CREATE TRIGGER fail_cost BEFORE UPDATE ON spend_commitments BEGIN SELECT RAISE(ABORT,'accounting failure'); END",
    );
    const action = () =>
      operation === 'complete'
        ? completeAttempt(db, token!, { text: 'done' }, 2)
        : operation === 'stop'
          ? stopAttempt(db, token!, 'partial', 'failed', 2)
          : operation === 'cancel'
            ? cancelRun(db, actor, id, 2)
            : recoverStale(db, 100);
    expect(action).toThrow('accounting failure');
    expect(readStoredRun(db, id).status).toBe(operation === 'cancel' ? 'queued' : 'running');
    expect(cost()).toEqual({ status: 'reserved' });
    expect(db.prepare('SELECT * FROM run_outputs').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM run_checkpoints').all()).toEqual([]);
    if (token) expect(attempt()).toEqual({ outcome: null, finished_at: null });
  },
);
it('rolls back attempt start and renewal when attempt persistence fails', () => {
  claimRun(db, 'worker', 100, 0);
  db.exec(
    "CREATE TRIGGER fail_start BEFORE INSERT ON run_attempts BEGIN SELECT RAISE(ABORT,'attempt failure'); END",
  );
  expect(() => startAttempt(db, id, 'worker', 1)).toThrow('attempt failure');
  expect(readStoredRun(db, id).status).toBe('claimed');
  db.exec('DROP TRIGGER fail_start');
  const token = startAttempt(db, id, 'worker', 1)!;
  db.exec(
    "CREATE TRIGGER fail_heartbeat BEFORE UPDATE ON run_attempts BEGIN SELECT RAISE(ABORT,'heartbeat failure'); END",
  );
  expect(() => renewAttempt(db, token, 100, 50)).toThrow('heartbeat failure');
  expect(readStoredRun(db, id).lease_until).toBe(100);
});
it('renews an active attempt and completes within the extended lease', () => {
  const token = start();
  expect(renewAttempt(db, token, 100, 50)).toBe(true);
  recoverStale(db, 100);
  expect(completeAttempt(db, token, { text: 'done' }, 149)).toBe(true);
});
