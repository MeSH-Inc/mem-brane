import type { RunRecord } from '../db/records.js';
import type { RunSummary, RunDetail } from '../../shared/contracts.js';
import { readInputs } from './context-reader.js';
import type { DB } from '../db/index.js';
import type { Run, Derivation, RelationEntry, RunPart } from '../../shared/types/domain.js';
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
    SELECT x.run_id FROM (SELECT DISTINCT block_id FROM placements WHERE brane_id=?) p
    CROSS JOIN run_parts x ON x.block_id=p.block_id
    UNION
    SELECT id FROM runs INDEXED BY runs_brane_active WHERE brane_id=?
    AND status IN ('queued','claimed','running','cancel_requested')
  ) SELECT ${fields},COALESCE(c.text,'') partial,
  machine.id machine_block_id,CASE WHEN machine.id IS NULL THEN NULL ELSE pv.source_version END machine_version,
  b.batch_id,b.position batch_position,sc.confirmed_microusd
  FROM selected s
  CROSS JOIN runs r ON r.id=s.id
  LEFT JOIN run_batches b ON b.run_id=r.id
  LEFT JOIN spend_commitments sc ON sc.run_id=r.id
  LEFT JOIN run_checkpoints c ON c.run_id=r.id AND r.status!='completed'
  LEFT JOIN context_entries pe ON pe.context_id=r.context_id AND pe.kind='prompt'
  LEFT JOIN block_revisions pv ON pv.id=pe.revision_id
  LEFT JOIN blocks machine ON machine.id=pv.block_id AND machine.kind='machine'
  ORDER BY r.created_at,r.id`,
    )
    .all(braneId, actor, braneId, braneId) as Run[];
}

export function readVisibleDerivations(db: DB, actor: string, braneId: string): Derivation[] {
  canReadBrane(db, actor, braneId);
  // CROSS JOIN fixes the outer loop at visible output identities, independent of
  // the size of the owner's run history. The unique index enforces one producer.
  return db
    .prepare(
      `SELECT * FROM (SELECT r.id runId,i.kind,i.label,v.block_id sourceBlockId,i.revision_id sourceRevisionId,v.source_version sourceVersion,
    r.output_block_id outputBlockId,i.position,l.anchor_placement_id anchorPlacementId,
    l.output_placement_id outputPlacementId
    FROM (SELECT DISTINCT block_id FROM placements WHERE brane_id=?) p
    CROSS JOIN runs r INDEXED BY runs_output_block ON r.output_block_id=p.block_id
    CROSS JOIN context_entries i ON i.context_id=r.context_id AND i.kind IN ('source','reference')
    JOIN block_revisions v ON v.id=i.revision_id
    LEFT JOIN run_placements l ON l.run_id=r.id
    WHERE r.owner_id=?
    UNION ALL
    SELECT r.id runId,i.kind,i.label,v.block_id sourceBlockId,i.revision_id sourceRevisionId,v.source_version sourceVersion,
    x.block_id outputBlockId,i.position,l.anchor_placement_id anchorPlacementId,NULL outputPlacementId
    FROM (SELECT DISTINCT block_id FROM placements WHERE brane_id=?) p
    CROSS JOIN run_parts x ON x.block_id=p.block_id
    JOIN runs r ON r.id=x.run_id
    CROSS JOIN context_entries i ON i.context_id=r.context_id AND i.kind IN ('source','reference')
    JOIN block_revisions v ON v.id=i.revision_id
    LEFT JOIN run_placements l ON l.run_id=r.id
    WHERE r.owner_id=?) d
    ORDER BY (SELECT created_at FROM runs WHERE id=d.runId),d.runId,d.outputBlockId,d.position`,
    )
    .all(braneId, actor, braneId, actor) as Derivation[];
}

// The cards a visible run's answer was split into, in item order: each is an output of
// the run as much as its whole answer is.
export function readVisibleParts(db: DB, actor: string, braneId: string): RunPart[] {
  canReadBrane(db, actor, braneId);
  return db
    .prepare(
      `SELECT x.run_id runId,x.block_id blockId,x.position FROM run_parts x
    JOIN runs r ON r.id=x.run_id
    WHERE r.owner_id=? AND x.run_id IN (
      SELECT x2.run_id FROM (SELECT DISTINCT block_id FROM placements WHERE brane_id=?) p
      CROSS JOIN run_parts x2 ON x2.block_id=p.block_id
    ) ORDER BY x.run_id,x.position`,
    )
    .all(actor, braneId) as RunPart[];
}

// The relations each visible output's run sent, by the blocks of the inputs they
// joined, so the workspace can tell when the arrows drawn now differ.
export function readVisibleRelationEntries(
  db: DB,
  actor: string,
  braneId: string,
): RelationEntry[] {
  canReadBrane(db, actor, braneId);
  return db
    .prepare(
      `SELECT r.id runId,fv.block_id fromBlockId,tv.block_id toBlockId,e.label
    FROM (SELECT DISTINCT block_id FROM placements WHERE brane_id=?) p
    CROSS JOIN runs r INDEXED BY runs_output_block ON r.output_block_id=p.block_id
    CROSS JOIN relation_entries e ON e.context_id=r.context_id
    JOIN context_entries f ON f.context_id=e.context_id AND f.position=e.from_position
    JOIN block_revisions fv ON fv.id=f.revision_id
    JOIN context_entries t ON t.context_id=e.context_id AND t.position=e.to_position
    JOIN block_revisions tv ON tv.id=t.revision_id
    WHERE r.owner_id=? ORDER BY r.created_at,e.position`,
    )
    .all(braneId, actor) as RelationEntry[];
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
    continue_from:
      db
        .prepare<unknown[], { parent_message_id: string | null }>(
          'SELECT parent_message_id FROM context_manifests WHERE id=?',
        )
        .get(run.context_id)?.parent_message_id ?? null,
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
          'SELECT status,reserved_microusd,confirmed_microusd FROM spend_commitments WHERE run_id=?',
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
