import { createContext, readInputs, type ContextEntry } from './contexts.js';
import { reserveCost, releaseUninvokedCost, type CostPolicy } from './costs.js';
import { createHash } from 'node:crypto';
import type { DB } from '../db/index.js';
import type { SubmissionReceipt, SubmitRun, SpawnArtifact } from '../../shared/types/domain.js';
import { canRunOnBrane, DomainError, requireOwned } from '../domain/access.js';
import { createBlock, now, uid, updateBlockLiveState, type RevisionService } from './content.js';
export interface RunLimits {
  costPolicy?: CostPolicy;
  models: string[];
  maxTokens: number;
  userConcurrency: number;
  queueLimit?: number;
  maxContextCharacters: number;
}
function checkLimits(db: DB, actor: string, model: string, limits: RunLimits) {
  if (!limits.models.includes(model)) throw new DomainError(400, 'Model is not allowed');
  const active = db
    .prepare(
      "SELECT count(*) n FROM runs WHERE owner_id=? AND status IN ('queued','claimed','running','cancel_requested')",
    )
    .get(actor) as any;
  const queued = db
    .prepare(
      "SELECT count(*) n FROM runs WHERE status IN ('queued','claimed','running','cancel_requested')",
    )
    .get() as { n: number };
  if (queued.n >= (limits.queueLimit ?? 8))
    throw new DomainError(429, 'Run queue capacity reached');
  if (active.n >= limits.userConcurrency)
    throw new DomainError(429, 'Concurrent run limit reached');
}
interface DeriveOptions {
  sources: string[];
  anchorPlacementId: string;
  action: 'develop';
}
export function submitRun(
  db: DB,
  snapshots: RevisionService,
  actor: string,
  input: SubmitRun,
  limits: RunLimits,
  derivation?: DeriveOptions,
) {
  const hash = createHash('sha256').update(JSON.stringify({ input, derivation })).digest('hex');
  return db.transaction(() => {
    canRunOnBrane(db, actor, input.braneId);
    const existing = db
      .prepare('SELECT * FROM runs WHERE owner_id=? AND submission_key=?')
      .get(actor, input.key) as any;
    if (existing) {
      if (existing.request_hash !== hash)
        throw new DomainError(409, 'Submission key was used for a different request');
      return existing;
    }
    checkLimits(db, actor, input.model, limits);
    const edits = input.edits.map((edit) => ({
      blockId: edit.blockId,
      ...updateBlockLiveState(db, actor, edit),
    }));
    const frozen: ContextEntry[] = [];
    const continuation = input.continueFrom
      ? (db
          .prepare(
            'SELECT m.conversation_id FROM conversation_messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=? AND c.owner_id=?',
          )
          .get(input.continueFrom, actor) as { conversation_id: string } | undefined)
      : undefined;
    if (input.continueFrom && !continuation)
      throw new DomainError(404, 'Conversation point not found');
    for (const [index, blockId] of (derivation?.sources ?? []).entries()) {
      const r = snapshots.snapshotBlock(actor, blockId);
      frozen.push({
        kind: 'source',
        label: index === 0 ? 'Primary source' : `Source ${index + 1}`,
        role: 'user',
        revisionId: r.id,
      });
    }
    for (const [index, blockId] of input.references.entries()) {
      const r = snapshots.snapshotBlock(actor, blockId);
      frozen.push({
        kind: 'reference',
        label: `Reference ${index + 1}`,
        role: 'user',
        revisionId: r.id,
      });
    }
    const prompt = createBlock(db, actor, 'text', { format: 'text', text: input.prompt });
    frozen.push({
      kind: 'prompt',
      label: 'Prompt',
      role: 'user',
      revisionId: snapshots.snapshotBlock(actor, prompt.id).id,
    });
    const anchor = derivation
      ? readAnchor(db, actor, input.braneId, derivation.anchorPlacementId, derivation.sources[0])
      : undefined;
    const output = createBlock(
      db,
      actor,
      'text',
      { format: 'text', text: '' },
      input.braneId,
      anchor
        ? childGeometry(db, anchor)
        : {
            x: 520,
            y:
              100 +
              (db.prepare('SELECT count(*) n FROM runs WHERE brane_id=?').get(input.braneId) as any)
                .n *
                60,
            width: 380,
            height: 300,
          },
      'generated',
    );
    const conversationId = continuation?.conversation_id ?? uid();
    if (!continuation)
      db.prepare('INSERT INTO conversations VALUES (?,?,?)').run(conversationId, actor, now());
    const contextId = createContext(db, actor, input.continueFrom, frozen);
    const runId = uid();
    db.prepare(
      `INSERT INTO runs (id,owner_id,brane_id,submission_key,request_hash,status,provider,model,options_json,output_block_id,conversation_id,context_id,created_at) VALUES (?,?,?,?,?,'queued',?,?,?,?,?,?,?)`,
    ).run(
      runId,
      actor,
      input.braneId,
      input.key,
      hash,
      input.model === 'mock' ? 'mock' : 'openai',
      input.model,
      JSON.stringify({
        ...(derivation ? { action: derivation.action, actionVersion: 1 } : {}),
        maxOutputTokens: Math.min(input.maxOutputTokens ?? limits.maxTokens, limits.maxTokens),
      }),
      output.id,
      conversationId,
      contextId,
      now(),
    );
    if (anchor)
      db.prepare('INSERT INTO run_placements VALUES (?,?,?)').run(
        runId,
        anchor.id,
        output.placement.id,
      );
    const inputs = readInputs(db, runId);
    const characters = inputs.reduce(
      (total, input) => total + JSON.stringify(input.content).length,
      0,
    );
    if (characters > limits.maxContextCharacters)
      throw new DomainError(400, 'Context is too large');
    reserveCost(
      db,
      actor,
      runId,
      input.model,
      inputs,
      Math.min(input.maxOutputTokens ?? limits.maxTokens, limits.maxTokens),
      limits.costPolicy,
    );
    db.prepare('INSERT INTO submission_receipts VALUES (?,?)').run(
      runId,
      JSON.stringify({ runId, outputBlockId: output.id, edits }),
    );
    return db.prepare('SELECT * FROM runs WHERE id=?').get(runId) as any;
  })();
}
export function cancelRun(db: DB, actor: string, id: string) {
  return db.transaction(() => {
    requireOwned(db, 'runs', actor, id);
    db.prepare(
      "UPDATE runs SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'cancel_requested' END,finished_at=CASE WHEN status='queued' THEN ? ELSE finished_at END WHERE id=? AND status IN ('queued','claimed','running')",
    ).run(now(), id);
    if ((db.prepare('SELECT status FROM runs WHERE id=?').get(id) as any).status === 'cancelled')
      releaseUninvokedCost(db, id);
  })();
}
export function retryRun(db: DB, actor: string, id: string, key: string, limits: RunLimits) {
  return db.transaction(() => {
    const old = requireOwned(db, 'runs', actor, id);
    canRunOnBrane(db, actor, old.brane_id);
    const duplicate = db
      .prepare('SELECT * FROM runs WHERE owner_id=? AND submission_key=?')
      .get(actor, key) as any;
    if (duplicate) {
      if (duplicate.retry_of !== id) throw new DomainError(409, 'Submission key already used');
      return duplicate;
    }
    if (!['failed', 'interrupted', 'cancelled'].includes(old.status))
      throw new DomainError(409, 'Only stopped runs can be retried');
    checkLimits(db, actor, old.model, limits);
    if (JSON.parse(old.options_json).maxOutputTokens > limits.maxTokens)
      throw new DomainError(409, 'Retry exceeds the current output limit; submit a new run');
    const layout = db.prepare('SELECT * FROM run_placements WHERE run_id=?').get(id) as any;
    const anchor = layout?.anchor_placement_id
      ? (db.prepare('SELECT * FROM placements WHERE id=?').get(layout.anchor_placement_id) as any)
      : undefined;
    const output = createBlock(
        db,
        actor,
        'text',
        { format: 'text', text: '' },
        old.brane_id,
        anchor
          ? childGeometry(db, anchor)
          : {
              x: 560,
              y: 180,
              width: 380,
              height: 300,
            },
        'generated',
      ),
      newId = uid();
    db.prepare(
      `INSERT INTO runs (id,owner_id,brane_id,submission_key,request_hash,status,provider,model,options_json,output_block_id,conversation_id,context_id,retry_of,created_at) VALUES (?,?,?,?,?,'queued',?,?,?,?,?,?,?,?)`,
    ).run(
      newId,
      actor,
      old.brane_id,
      key,
      old.request_hash,
      old.provider,
      old.model,
      old.options_json,
      output.id,
      old.conversation_id,
      old.context_id,
      id,
      now(),
    );
    if (layout)
      db.prepare('INSERT INTO run_placements VALUES (?,?,?)').run(
        newId,
        anchor?.id ?? null,
        output.placement.id,
      );
    reserveCost(
      db,
      actor,
      newId,
      old.model,
      readInputs(db, newId),
      JSON.parse(old.options_json).maxOutputTokens,
      limits.costPolicy,
    );
    return db.prepare('SELECT * FROM runs WHERE id=?').get(newId) as any;
  })();
}

function readAnchor(db: DB, actor: string, braneId: string, placementId: string, sourceId: string) {
  canRunOnBrane(db, actor, braneId);
  const anchor = db
    .prepare('SELECT * FROM placements WHERE id=? AND brane_id=? AND block_id=?')
    .get(placementId, braneId, sourceId) as any;
  if (!anchor)
    throw new DomainError(400, 'Spawn anchor must place the primary source in this brane');
  return anchor;
}
function childGeometry(db: DB, anchor: any) {
  const x = anchor.x + anchor.width + 80;
  let y = anchor.y;
  const occupied = db
    .prepare('SELECT x,y,width,height FROM placements WHERE brane_id=? ORDER BY y')
    .all(anchor.brane_id) as any[];
  for (const p of occupied) {
    if (
      x < p.x + p.width + 24 &&
      x + 380 + 24 > p.x &&
      y < p.y + p.height + 24 &&
      y + 300 + 24 > p.y
    )
      y = p.y + p.height + 40;
  }
  return { x, y, width: 380, height: 300 };
}
export function spawnArtifact(
  db: DB,
  snapshots: RevisionService,
  actor: string,
  input: SpawnArtifact,
  limits: RunLimits,
) {
  if (
    input.action !== 'develop' ||
    !input.sourceBlockIds.length ||
    input.sourceBlockIds.length > 32 ||
    new Set(input.sourceBlockIds).size !== input.sourceBlockIds.length ||
    input.edits.some((e) => !input.sourceBlockIds.includes(e.blockId))
  )
    throw new DomainError(400, 'Invalid spawn sources or action');
  return submitRun(
    db,
    snapshots,
    actor,
    {
      braneId: input.braneId,
      key: input.key,
      model: input.model,
      prompt:
        'Develop this artifact into a useful next artifact. Answer explicit requests directly; otherwise expand the central idea into a concrete, self-contained result. Return only the resulting artifact.',
      references: [],
      edits: input.edits,
    },
    limits,
    {
      sources: input.sourceBlockIds,
      anchorPlacementId: input.anchorPlacementId,
      action: input.action,
    },
  );
}

export function readSubmissionReceipt(db: DB, actor: string, runId: string): SubmissionReceipt {
  requireOwned(db, 'runs', actor, runId);
  const row = db
    .prepare('SELECT receipt_json FROM submission_receipts WHERE run_id=?')
    .get(runId) as { receipt_json: string } | undefined;
  if (!row) throw new DomainError(409, 'This run has no submission receipt');
  return JSON.parse(row.receipt_json) as SubmissionReceipt;
}
