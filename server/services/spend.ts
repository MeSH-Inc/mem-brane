import type { DB } from '../db/index.js';
import { decodeRecord, costCommitmentRecord } from '../db/records.js';
import { money, usdLimit, type Microusd } from '../domain/money.js';
import { DomainError } from '../domain/access.js';

export interface SpendLimits {
  globalDailyLimitUsd?: number;
  globalMonthlyLimitUsd?: number;
}
export interface ActorLimits extends SpendLimits {
  userDailyLimitUsd?: number;
}
export function committedSpend(db: DB, period: string, filter: { actor?: string } = {}): Microusd {
  const clauses: string[] = [];
  const args: string[] = [period + '%'];
  if (filter.actor) {
    clauses.push(
      'owner_id IN (SELECT id FROM libraries WHERE principal_id=(SELECT principal_id FROM libraries WHERE id=?))',
    );
    args.push(filter.actor);
  }
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE
    WHEN status IN ('reserved','uncertain') THEN reserved_microusd
    WHEN status='confirmed' AND budget_day LIKE ? THEN confirmed_microusd ELSE 0 END),0) committed
    FROM spend_commitments ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}`,
    )
    .safeIntegers()
    .get(...args);
  return money(decodeRecord(costCommitmentRecord, row).committed);
}
export function spendHeadroom(db: DB, actor: string, limits: ActorLimits, time = Date.now()) {
  const day = new Date(time).toISOString().slice(0, 10),
    month = day.slice(0, 7);
  const checks: [number | undefined, string, { actor?: string }][] = [
    [limits.globalDailyLimitUsd, day, {}],
    [limits.globalMonthlyLimitUsd, month, {}],
    [limits.userDailyLimitUsd, day, { actor }],
  ];
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    ...checks
      .filter(([limit]) => limit !== undefined)
      .map(([limit, period, filter]) => usdLimit(limit!) - committedSpend(db, period, filter)),
  );
}
// Callers include their run writes in this same IMMEDIATE transaction.
export function reserveSpend(
  db: DB,
  input: {
    runId: string;
    actor: string;
    amount: number;
    units: number;
    pricing: unknown;
  },
  limits: ActorLimits,
  time = Date.now(),
) {
  return db
    .transaction(() => {
      const amount = money(input.amount);
      if (
        amount > 0 &&
        (!(limits.globalDailyLimitUsd! > 0) || !(limits.globalMonthlyLimitUsd! > 0))
      )
        throw new DomainError(
          403,
          'Paid work requires positive global daily and monthly budgets',
          'budget',
        );
      if (!Number.isSafeInteger(input.units) || input.units < 0)
        throw new RangeError('Invalid spend units');
      if (amount > spendAvailable(db, input.actor, limits, time))
        throw new DomainError(
          429,
          'Spend budget is fully committed, including uncertain previous calls',
          'budget',
        );
      db.prepare(
        `INSERT INTO spend_commitments
      (run_id,owner_id,budget_day,status,reserved_microusd,estimated_units,confirmed_microusd,pricing_json,created_at,updated_at)
      VALUES (?,?,?,'reserved',?,?,NULL,?,?,?)`,
      ).run(
        input.runId,
        input.actor,
        new Date(time).toISOString().slice(0, 10),
        amount,
        input.units,
        JSON.stringify(input.pricing),
        time,
        time,
      );
    })
    .immediate();
}
export function reconcileSpend(db: DB, runId: string, amount: number, evidence: string) {
  if (!Number.isSafeInteger(amount) || amount < 0 || evidence.trim().length < 8)
    throw new DomainError(
      400,
      'Provide a nonnegative integer micro-USD amount and provider evidence',
    );
  return db
    .transaction(() => {
      const changed = db
        .prepare(
          "UPDATE spend_commitments SET status='confirmed',confirmed_microusd=?,updated_at=? WHERE run_id=? AND status='uncertain'",
        )
        .run(money(amount), Date.now(), runId);
      if (!changed.changes) throw new DomainError(409, 'Only uncertain billing can be reconciled');
      db.prepare('INSERT INTO spend_reconciliations VALUES (?,?,?,?)').run(
        runId,
        amount,
        evidence.trim(),
        Date.now(),
      );
    })
    .immediate();
}

export function spendAvailable(db: DB, actor: string, limits: ActorLimits, time = Date.now()) {
  return Math.max(0, spendHeadroom(db, actor, limits, time));
}
