import { modelProvider } from '../llm/provider.js';
import { planRun, relationEntryText, type MachinePlan, type RunPlanLimits } from './run-plan.js';
import { machineSlots, orderMachineInputs, type RunMachine } from '../../shared/machines.js';
import { loadBlockStates } from './block-state.js';
import { estimateRun } from './estimate.js';
import { decodeRecord, decodeJson, runRecord, runOptions, type RunRecord } from '../db/records.js';
import type { Placement, Geometry } from '../../shared/types/domain.js';
import { submissionReceipt } from '../../shared/schemas/index.js';
import { createContext, type ContextEntry } from './contexts.js';
import { readInputs } from './context-reader.js';
import { reserveCost, quoteCost } from './costs.js';
import { createHash } from 'node:crypto';
import type { DB } from '../db/index.js';
import type { SubmissionReceipt, SubmitRun, SpawnArtifact } from '../../shared/types/domain.js';
import { canRunOnBrane, DomainError, requireOwned } from '../domain/access.js';
import { createBlock, now, uid, updateBlockLiveState, type RevisionService } from './content.js';
export interface RunLimits extends RunPlanLimits {
  userConcurrency: number;
  queueLimit?: number;
}
function checkLimits(db: DB, actor: string, model: string, limits: RunLimits) {
  if (!limits.models.includes(model)) throw new DomainError(400, 'Model is not allowed');
  const active = db
    .prepare(
      "SELECT count(*) n FROM runs WHERE owner_id=? AND status IN ('queued','claimed','running','cancel_requested')",
    )
    .get(actor) as { n: number };
  const queued = db
    .prepare(
      "SELECT count(*) n FROM runs WHERE status IN ('queued','claimed','running','cancel_requested')",
    )
    .get() as { n: number };
  if (queued.n >= (limits.queueLimit ?? 8))
    throw new DomainError(429, 'Run queue capacity reached', 'capacity');
  if (active.n >= limits.userConcurrency)
    throw new DomainError(429, 'Concurrent run limit reached', 'capacity');
}
interface DeriveOptions {
  sources: string[];
  anchorPlacementId: string;
  action: 'develop';
}
interface MachineOptions extends MachinePlan {
  placement: Placement;
}
export function submitRun(
  db: DB,
  snapshots: RevisionService,
  actor: string,
  input: SubmitRun,
  limits: RunLimits,
  derivation?: DeriveOptions,
  machine?: MachineOptions,
) {
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        input,
        derivation,
        machine: machine && {
          blockId: machine.blockId,
          slots: machine.slots,
          placementId: machine.placement.id,
        },
      }),
    )
    .digest('hex');
  return db.transaction(() => {
    canRunOnBrane(db, actor, input.braneId);
    const existing = db
      .prepare('SELECT * FROM runs WHERE owner_id=? AND submission_key=?')
      .get(actor, input.key);
    if (existing) {
      const run = decodeRecord(runRecord, existing);
      if (run.request_hash !== hash)
        throw new DomainError(409, 'Submission key was used for a different request');
      return run;
    }
    checkLimits(db, actor, input.model, limits);
    const plan = planRun(db, actor, input, limits, derivation?.sources, machine);
    if (input.maxReservedMicrousd !== undefined && plan.quote.amount > input.maxReservedMicrousd)
      throw new DomainError(
        409,
        'Run reservation exceeds the accepted cost cap. Request a new estimate.',
      );
    const edits = input.edits.map((edit) => ({
      blockId: edit.blockId,
      ...updateBlockLiveState(db, actor, edit),
    }));
    // Inputs freeze first; a relation entry then names their frozen revisions.
    const revisions: string[] = [];
    const freeze = (blockId: string) => snapshots.snapshotBlock(actor, blockId).id;
    plan.entries.forEach((entry, index) => {
      if (entry.relation) return;
      revisions[index] = freeze(
        entry.blockId ?? createBlock(db, actor, 'text', { format: 'text', text: input.prompt }).id,
      );
    });
    plan.entries.forEach((entry, index) => {
      if (!entry.relation) return;
      const text = relationEntryText(plan.entries, revisions, entry.relation);
      revisions[index] = freeze(createBlock(db, actor, 'text', { format: 'text', text }).id);
    });
    const frozen: ContextEntry[] = plan.entries.map((entry, index) => ({
      kind: entry.kind,
      label: entry.label,
      role: 'user',
      revisionId: revisions[index],
    }));
    const anchor = machine
      ? machine.placement
      : derivation
        ? readAnchor(db, actor, input.braneId, derivation.anchorPlacementId, derivation.sources[0])
        : contextAnchor(db, input.braneId, input.references, input.continueFrom);
    // The output attaches to what was run: a development goes on its source's back, and
    // a machine's output or an updated answer takes the place of the one it replaces.
    const host = derivation && anchor ? (anchor.host_placement_id ?? anchor.id) : null;
    const replaced = machine
      ? trayOutput(db, machine.placement.id)
      : input.replacesPlacementId
        ? replacedAnswer(db, input.braneId, input.replacesPlacementId)
        : undefined;
    const output = createBlock(
      db,
      actor,
      'text',
      { format: 'text', text: '' },
      input.braneId,
      replaced
        ? { x: replaced.x, y: replaced.y, width: replaced.width, height: replaced.height }
        : input.outputGeometry && !host
          ? input.outputGeometry
          : host && anchor
            ? { x: anchor.x + anchor.width + 80, y: anchor.y, width: 380, height: 300 }
            : anchor
              ? childGeometry(db, anchor)
              : openGeometry(db, input.braneId, 520, 100),
      'generated',
      undefined,
      host,
    );
    if (replaced) moveToBack(db, replaced, output.placement.id);
    const conversationId = plan.conversationId ?? uid();
    if (!plan.conversationId)
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
      modelProvider(input.model),
      input.model,
      JSON.stringify({
        ...(derivation ? { action: derivation.action, actionVersion: 1 } : {}),
        maxOutputTokens: plan.maxOutputTokens,
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
    reserveCost(db, actor, runId, plan.quote, limits.costPolicy);
    db.prepare('INSERT INTO submission_receipts VALUES (?,?)').run(
      runId,
      JSON.stringify({ runId, outputBlockId: output.id, edits }),
    );
    return readStoredRun(db, runId);
  })();
}
export function retryRun(db: DB, actor: string, id: string, key: string, limits: RunLimits) {
  return db.transaction(() => {
    const old = requireOwned(db, 'runs', actor, id);
    canRunOnBrane(db, actor, old.brane_id);
    const duplicate = db
      .prepare('SELECT * FROM runs WHERE owner_id=? AND submission_key=?')
      .get(actor, key);
    if (duplicate) {
      const run = decodeRecord(runRecord, duplicate);
      if (run.retry_of !== id) throw new DomainError(409, 'Submission key already used');
      return run;
    }
    if (!['failed', 'interrupted', 'cancelled'].includes(old.status))
      throw new DomainError(409, 'Only stopped runs can be retried');
    checkLimits(db, actor, old.model, limits);
    if (decodeJson(runOptions, old.options_json).maxOutputTokens > limits.maxTokens)
      throw new DomainError(409, 'Retry exceeds the current output limit; submit a new run');
    const layout = db
      .prepare<
        unknown[],
        { anchor_placement_id: string | null; output_placement_id: string | null }
      >('SELECT * FROM run_placements WHERE run_id=?')
      .get(id);
    const placementOf = db.prepare<unknown[], Placement>('SELECT * FROM placements WHERE id=?');
    const anchor = layout?.anchor_placement_id
      ? placementOf.get(layout.anchor_placement_id)
      : undefined;
    // A retry lands where the stopped output is: on the same back, if it was on one.
    const stopped = layout?.output_placement_id
      ? placementOf.get(layout.output_placement_id)
      : undefined;
    const output = createBlock(
        db,
        actor,
        'text',
        { format: 'text', text: '' },
        old.brane_id,
        anchor ? childGeometry(db, anchor) : openGeometry(db, old.brane_id, 560, 180),
        'generated',
        undefined,
        stopped?.host_placement_id ?? null,
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
      quoteCost(
        old.model,
        readInputs(db, newId),
        decodeJson(runOptions, old.options_json).maxOutputTokens,
        limits.costPolicy,
      ),
      limits.costPolicy,
    );
    return readStoredRun(db, newId);
  })();
}

function readAnchor(db: DB, actor: string, braneId: string, placementId: string, sourceId: string) {
  canRunOnBrane(db, actor, braneId);
  const anchor = db
    .prepare<unknown[], Placement>(
      'SELECT * FROM placements WHERE id=? AND brane_id=? AND block_id=?',
    )
    .get(placementId, braneId, sourceId);
  if (!anchor)
    throw new DomainError(400, 'Spawn anchor must place the primary source in this brane');
  return anchor;
}
// Composed runs sit beside their first on-brane reference, or the message they continue.
function contextAnchor(db: DB, braneId: string, references: string[], continueFrom?: string) {
  const find = db.prepare<unknown[], Placement>(
    'SELECT * FROM placements WHERE brane_id=? AND block_id=? ORDER BY rowid LIMIT 1',
  );
  for (const blockId of references) {
    const placement = find.get(braneId, blockId);
    if (placement) return placement;
  }
  if (!continueFrom) return undefined;
  const message = db
    .prepare<unknown[], { block_id: string }>(
      'SELECT v.block_id FROM conversation_messages m JOIN block_revisions v ON v.id=m.revision_id WHERE m.id=?',
    )
    .get(continueFrom);
  return message ? find.get(braneId, message.block_id) : undefined;
}
// The machine's current tray output: its newest output still on the table.
function trayOutput(db: DB, machinePlacementId: string) {
  return db
    .prepare<unknown[], Placement>(
      `SELECT p.* FROM run_placements l JOIN runs r ON r.id=l.run_id
       JOIN placements p ON p.id=l.output_placement_id
       WHERE l.anchor_placement_id=? AND p.host_placement_id IS NULL
       ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1`,
    )
    .get(machinePlacementId);
}
// An answer being updated must still be a generated card on this brane's table.
function replacedAnswer(db: DB, braneId: string, placementId: string) {
  const placement = db
    .prepare<unknown[], Placement>(
      `SELECT p.* FROM placements p JOIN blocks b ON b.id=p.block_id
       WHERE p.id=? AND p.brane_id=? AND p.host_placement_id IS NULL AND b.origin='generated'`,
    )
    .get(placementId, braneId);
  if (!placement) throw new DomainError(409, 'This answer is no longer on the table.');
  return placement;
}
// The replaced output, and anything already on its back, move to the new output's
// back. Feeds it gave other machines follow the tray, keeping their position in each
// slot, so those machines see the new output and go stale instead of running on;
// arrows follow it too.
function moveToBack(db: DB, replaced: Placement, outputPlacementId: string) {
  const time = now();
  const rehost = db.prepare(
    'UPDATE placements SET host_placement_id=?,version=version+1,updated_at=? WHERE host_placement_id=?',
  );
  rehost.run(outputPlacementId, time, replaced.id);
  db.prepare(
    'UPDATE placements SET host_placement_id=?,version=version+1,updated_at=? WHERE id=?',
  ).run(outputPlacementId, time, replaced.id);
  const feeds = db
    .prepare<
      unknown[],
      { position: number; id: string; to_placement_id: string; slot: string; created_at: number }
    >(
      'SELECT rowid position,id,to_placement_id,slot,created_at FROM feeds WHERE from_placement_id=?',
    )
    .all(replaced.id);
  for (const feed of feeds) {
    db.prepare('DELETE FROM feeds WHERE id=?').run(feed.id);
    db.prepare(
      'INSERT INTO feeds (rowid,id,brane_id,from_placement_id,to_placement_id,slot,created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(
      feed.position,
      uid(),
      replaced.brane_id,
      outputPlacementId,
      feed.to_placement_id,
      feed.slot,
      feed.created_at,
    );
  }
  // Arrows to and from the replaced card now join the card that replaced it.
  db.prepare('UPDATE relations SET from_placement_id=? WHERE from_placement_id=?').run(
    outputPlacementId,
    replaced.id,
  );
  db.prepare('UPDATE relations SET to_placement_id=? WHERE to_placement_id=?').run(
    outputPlacementId,
    replaced.id,
  );
}
function childGeometry(db: DB, anchor: Placement) {
  return openGeometry(db, anchor.brane_id, anchor.x + anchor.width + 80, anchor.y);
}
// Slide down from the preferred point until the output overlaps no existing placement.
function openGeometry(db: DB, braneId: string, x: number, preferredY: number): Geometry {
  const width = 380,
    height = 300,
    gap = 24;
  const occupied = db
    .prepare<unknown[], Geometry>(
      'SELECT x,y,width,height FROM placements WHERE brane_id=? AND host_placement_id IS NULL',
    )
    .all(braneId)
    .filter((p) => x < p.x + p.width + gap && x + width + gap > p.x)
    .sort((a, b) => a.y - b.y);
  let y = preferredY;
  for (const p of occupied)
    if (y < p.y + p.height + gap && y + height + gap > p.y) y = p.y + p.height + 40;
  return { x, y, width, height };
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

// Resolve a machine run into an ordinary frozen submission. The client names every
// input; the server checks them against the template the run will freeze.
function machineSubmission(db: DB, actor: string, input: RunMachine) {
  canRunOnBrane(db, actor, input.braneId);
  const placement = db
    .prepare<unknown[], Placement>('SELECT * FROM placements WHERE id=? AND brane_id=?')
    .get(input.machinePlacementId, input.braneId);
  if (!placement) throw new DomainError(400, 'The machine is not placed on this brane.');
  const state = loadBlockStates(db, actor, [placement.block_id]).get(placement.block_id)!;
  if (state.kind !== 'machine') throw new DomainError(400, 'Only a machine can be run this way.');
  const allowed = new Set([placement.block_id, ...input.inputs.map((i) => i.blockId)]);
  if (input.edits.some((edit) => !allowed.has(edit.blockId)))
    throw new DomainError(400, 'Only the machine and its inputs may be edited with a run.');
  const draft = input.edits.find((edit) => edit.blockId === placement.block_id);
  const template =
    draft?.text ?? (JSON.parse(state.live_json ?? '{"text":""}') as { text: string }).text;
  const slots = machineSlots(template);
  if (!slots.length) throw new DomainError(400, 'Name at least one {slot} in the machine prompt.');
  const unknown = input.inputs.find((i) => !slots.includes(i.slot));
  if (unknown) throw new DomainError(400, `The prompt has no {${unknown.slot}} slot.`);
  const empty = slots.find((slot) => !input.inputs.some((i) => i.slot === slot));
  if (empty) throw new DomainError(400, `Feed the {${empty}} slot first.`);
  const keys = input.inputs.map((i) => `${i.slot}\u0000${i.blockId}`);
  if (new Set(keys).size !== keys.length)
    throw new DomainError(400, 'A card may fill a slot only once.');
  const ordered = orderMachineInputs(template, input.inputs);
  const submission: SubmitRun = {
    braneId: input.braneId,
    key: input.key,
    model: input.model,
    prompt: template,
    references: ordered.map((i) => i.blockId),
    edits: input.edits,
    maxOutputTokens: input.maxOutputTokens,
    maxReservedMicrousd: input.maxReservedMicrousd,
  };
  return {
    submission,
    machine: { blockId: placement.block_id, slots: ordered.map((i) => i.slot), placement },
  };
}
export function runMachine(
  db: DB,
  snapshots: RevisionService,
  actor: string,
  input: RunMachine,
  limits: RunLimits,
) {
  const { submission, machine } = machineSubmission(db, actor, input);
  return submitRun(db, snapshots, actor, submission, limits, undefined, machine);
}
export function estimateMachine(db: DB, actor: string, input: RunMachine, limits: RunLimits) {
  const { submission, machine } = machineSubmission(db, actor, input);
  return estimateRun(db, actor, submission, limits, machine);
}

export function readSubmissionReceipt(db: DB, actor: string, runId: string): SubmissionReceipt {
  requireOwned(db, 'runs', actor, runId);
  const row = db
    .prepare('SELECT receipt_json FROM submission_receipts WHERE run_id=?')
    .get(runId) as { receipt_json: string } | undefined;
  if (!row) throw new DomainError(409, 'This run has no submission receipt');
  return decodeJson(submissionReceipt, row.receipt_json);
}

export function readStoredRun(db: DB, id: string): RunRecord {
  return decodeRecord(runRecord, db.prepare('SELECT * FROM runs WHERE id=?').get(id));
}
