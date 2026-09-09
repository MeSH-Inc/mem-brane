import type { RunRecord } from '../db/records.js';
import type { RunSummary, RunDetail } from '../../shared/contracts.js';
import { readInputs } from './contexts.js';
import type { DB } from '../db/index.js';
import type { Run, Derivation } from '../../shared/types/domain.js';
import type { RunPage } from '../../shared/types/history.js';
import { canReadBrane, DomainError, requireOwned } from '../domain/access.js';

const fields =
  'r.id,r.brane_id,r.status,r.model,r.provider,r.output_block_id,r.error,r.usage_json,r.retry_of,r.created_at';

export function readWorkspaceRuns(db: DB, actor: string, braneId: string): Run[] {
  canReadBrane(db, actor, braneId);
  return db
    .prepare(
      `WITH selected AS (
    SELECT r.id FROM (SELECT DISTINCT block_id FROM placements WHERE brane_id=?) p
    CROSS JOIN runs r INDEXED BY runs_output_block ON r.output_block_id=p.block_id
    WHERE r.owner_id=?
    UNION
    SELECT id FROM runs INDEXED BY runs_brane_active WHERE brane_id=?
    AND status IN ('queued','claimed','running','cancel_requested')
  ) SELECT ${fields},COALESCE(c.text,'') partial FROM selected s
  CROSS JOIN runs r ON r.id=s.id
  LEFT JOIN run_checkpoints c ON c.run_id=r.id AND r.status!='completed'
  ORDER BY r.created_at,r.id`,
    )
    .all(braneId, actor, braneId) as Run[];
}

export function readVisibleDerivations(db: DB, actor: string, braneId: string): Derivation[] {
  canReadBrane(db, actor, braneId);
  // CROSS JOIN fixes the outer loop at visible output identities, independent of
  // the size of the owner's run history. The unique index enforces one producer.
  return db
    .prepare(
      `SELECT r.id runId,v.block_id sourceBlockId,i.revision_id sourceRevisionId,
    r.output_block_id outputBlockId,i.position,l.anchor_placement_id anchorPlacementId,
    l.output_placement_id outputPlacementId
    FROM (SELECT DISTINCT block_id FROM placements WHERE brane_id=?) p
    CROSS JOIN runs r INDEXED BY runs_output_block ON r.output_block_id=p.block_id
    CROSS JOIN context_entries i ON i.context_id=r.context_id AND i.kind='source'
    JOIN block_revisions v ON v.id=i.revision_id
    LEFT JOIN run_placements l ON l.run_id=r.id
    WHERE r.owner_id=? ORDER BY r.created_at,i.position`,
    )
    .all(braneId, actor) as Derivation[];
}

export function readRunPage(
  db: DB,
  actor: string,
  braneId: string,
  limit = 25,
  cursor?: string,
): RunPage {
  canReadBrane(db, actor, braneId);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new DomainError(400, 'Run page limit must be 1..50');
  const anchor = cursor
    ? (db
        .prepare('SELECT created_at,id FROM runs WHERE brane_id=? AND id=?')
        .get(braneId, cursor) as { created_at: number; id: string } | undefined)
    : undefined;
  if (cursor && !anchor) throw new DomainError(400, 'Invalid run cursor');
  const rows = (
    anchor
      ? db
          .prepare(
            `SELECT ${fields} FROM runs r WHERE brane_id=? AND (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT ?`,
          )
          .all(braneId, anchor.created_at, anchor.id, limit + 1)
      : db
          .prepare(
            `SELECT ${fields} FROM runs r WHERE brane_id=? ORDER BY created_at DESC,id DESC LIMIT ?`,
          )
          .all(braneId, limit + 1)
  ) as RunPage['items'];
  return {
    items: rows.slice(0, limit),
    nextCursor: rows.length > limit ? rows[limit - 1].id : null,
  };
}

// Public inspection deliberately excludes ownership, submission hashes and lease machinery.
export function runSummary(run: RunRecord): RunSummary {
  return {
    id: run.id,
    brane_id: run.brane_id,
    status: run.status,
    model: run.model,
    provider: run.provider,
    output_block_id: run.output_block_id,
    error: run.error,
    usage_json: run.usage_json,
    retry_of: run.retry_of,
    created_at: run.created_at,
  };
}
export function readRunDetail(db: DB, actor: string, id: string): RunDetail {
  const run = requireOwned(db, 'runs', actor, id);
  return {
    ...runSummary(run),
    started_at: run.started_at,
    finished_at: run.finished_at,
    inputs: readInputs(db, run.id),
    output:
      db
        .prepare<unknown[], NonNullable<RunDetail['output']>>(
          'SELECT revision_id,message_id FROM run_outputs WHERE run_id=?',
        )
        .get(run.id) ?? null,
    cost:
      db
        .prepare<unknown[], NonNullable<RunDetail['cost']>>(
          'SELECT status,reserved_microusd,confirmed_microusd FROM run_costs WHERE run_id=?',
        )
        .get(run.id) ?? null,
    checkpoint:
      db
        .prepare<unknown[], NonNullable<RunDetail['checkpoint']>>(
          'SELECT text,updated_at FROM run_checkpoints WHERE run_id=?',
        )
        .get(run.id) ?? null,
  };
}
