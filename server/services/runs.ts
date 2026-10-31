import { modelProvider } from '../llm/provider.js';
import { planRun, relationEntryText, type MachinePlan, type RunPlanLimits } from './run-plan.js';
import {
  machineSlots,
  orderMachineInputs,
  MAX_EACH_RUNS,
  type RunMachine,
} from '../../shared/machines.js';
import { loadBlockStates } from './block-state.js';
import { estimateRun } from './estimate.js';
import { decodeRecord, decodeJson, runRecord, runOptions, type RunRecord } from '../db/records.js';
import type { Placement, Geometry, EditReceipt } from '../../shared/types/domain.js';
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
// The runs one press admits together count once against the limits: they are one
// request, which the workers share fairly with other owners' runs.
function checkLimits(db: DB, actor: string, model: string, limits: RunLimits) {
  if (!limits.models.includes(model)) throw new DomainError(400, 'Model is not allowed');
  const active = db
    .prepare(
      `SELECT count(DISTINCT COALESCE(b.batch_id,r.id)) n FROM runs r
       LEFT JOIN run_batches b ON b.run_id=r.id
       WHERE r.owner_id=? AND r.status IN ('queued','claimed','running','cancel_requested')`,
    )
    .get(actor) as { n: number };
  const queued = db
    .prepare(
      `SELECT count(DISTINCT COALESCE(b.batch_id,r.id)) n FROM runs r
       LEFT JOIN run_batches b ON b.run_id=r.id
       WHERE r.status IN ('queued','claimed','running','cancel_requested')`,
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
// Where a machine run's output goes when the press decides it: in place of a card of the
// machine's tray, or at the given geometry; and the batch the run belongs to.
interface OutputPlan {
  replaces: Placement | null;
  geometry: Geometry;
  batch?: { id: string; position: number };
  // A batch checks the limits and applies its edits once, before its first run.
  admitted: boolean;
  appliedEdits: EditReceipt[];
}
export function submitRun(
  db: DB,
  snapshots: RevisionService,
  actor: string,
  input: SubmitRun,
  limits: RunLimits,
  derivation?: DeriveOptions,
  machine?: MachineOptions,
  outputPlan?: OutputPlan,
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
    if (!outputPlan?.admitted) checkLimits(db, actor, input.model, limits);
    const plan = planRun(db, actor, input, limits, derivation?.sources, machine);
    if (input.maxReservedMicrousd !== undefined && plan.quote.amount > input.maxReservedMicrousd)
      throw new DomainError(
        409,
        'Run reservation exceeds the accepted cost cap. Request a new estimate.',
      );
    const edits = [
      ...(outputPlan?.appliedEdits ?? []),
      ...input.edits.map((edit) => ({
        blockId: edit.blockId,
        ...updateBlockLiveState(db, actor, edit),
      })),
    ];
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
      relation: entry.relation,
    }));
    const anchor = machine
      ? machine.placement
      : derivation
        ? readAnchor(db, actor, input.braneId, derivation.anchorPlacementId, derivation.sources[0])
        : contextAnchor(db, input.braneId, input.references, input.continueFrom);
    // The output attaches to what was run: a development goes on its source's back, and
    // a machine's output or an updated answer takes the place of the one it replaces.
    const host = derivation && anchor ? (anchor.host_placement_id ?? anchor.id) : null;
    const replaced = outputPlan
      ? (outputPlan.replaces ?? undefined)
      : machine
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
        : outputPlan
          ? outputPlan.geometry
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
    if (outputPlan?.batch)
      db.prepare('INSERT INTO run_batches VALUES (?,?,?)').run(
        runId,
        outputPlan.batch.id,
        outputPlan.batch.position,
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
    // A retry takes its run's place in the run's batch.
    db.prepare(
      'INSERT INTO run_batches SELECT ?,batch_id,position FROM run_batches WHERE run_id=?',
    ).run(newId, id);
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
// The machine's current tray output: its newest output still on the table, which for
// an answer split into cards is its first card still there.
function trayOutput(db: DB, machinePlacementId: string) {
  return db
    .prepare<unknown[], Placement>(
      `SELECT p.* FROM run_placements l JOIN runs r ON r.id=l.run_id
       JOIN (SELECT o.run_id,o.output_placement_id placement_id,-1 position FROM run_placements o
         UNION ALL SELECT x.run_id,q.id,x.position FROM run_parts x
         JOIN placements q ON q.block_id=x.block_id) out ON out.run_id=r.id
       JOIN placements p ON p.id=out.placement_id
       WHERE l.anchor_placement_id=? AND p.host_placement_id IS NULL
       ORDER BY r.created_at DESC,r.rowid DESC,out.position LIMIT 1`,
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
// arrows and group membership follow it too.
// What a feed comes from: one card, or one group.
export type FeedSource = { placementId: string } | { groupId: string };
// The feeds a source gives move to another source, each keeping its place in its slot
// (its rowid) and its creation time; a feed the new source already gives is dropped.
// A feed onto a card runs together, since only a group runs each.
export function moveFeeds(db: DB, braneId: string, from: FeedSource, to: FeedSource) {
  const feeds = db
    .prepare<
      unknown[],
      {
        position: number;
        id: string;
        to_placement_id: string;
        slot: string;
        mode: string;
        created_at: number;
      }
    >(
      `SELECT rowid position,id,to_placement_id,slot,mode,created_at FROM feeds
       WHERE ${'placementId' in from ? 'from_placement_id' : 'from_group_id'}=?`,
    )
    .all('placementId' in from ? from.placementId : from.groupId);
  for (const feed of feeds) {
    db.prepare('DELETE FROM feeds WHERE id=?').run(feed.id);
    db.prepare(
      `INSERT OR IGNORE INTO feeds (rowid,id,brane_id,from_placement_id,from_group_id,to_placement_id,slot,mode,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      feed.position,
      uid(),
      braneId,
      'placementId' in to ? to.placementId : null,
      'groupId' in to ? to.groupId : null,
      feed.to_placement_id,
      feed.slot,
      'groupId' in to ? feed.mode : 'together',
      feed.created_at,
    );
  }
}
export function moveToBack(db: DB, replaced: Placement, outputPlacementId: string) {
  const time = now();
  // The new card takes the replaced card's place in its group while both are on the table.
  db.prepare('UPDATE group_members SET placement_id=? WHERE placement_id=?').run(
    outputPlacementId,
    replaced.id,
  );
  const rehost = db.prepare(
    'UPDATE placements SET host_placement_id=?,version=version+1,updated_at=? WHERE host_placement_id=?',
  );
  rehost.run(outputPlacementId, time, replaced.id);
  db.prepare(
    'UPDATE placements SET host_placement_id=?,version=version+1,updated_at=? WHERE id=?',
  ).run(outputPlacementId, time, replaced.id);
  moveFeeds(
    db,
    replaced.brane_id,
    { placementId: replaced.id },
    { placementId: outputPlacementId },
  );
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
// input; the server checks them against the template the run will freeze. A batch run
// resolves each of its runs over a part of the inputs.
function machineSubmission(
  db: DB,
  actor: string,
  input: RunMachine,
  inputs: RunMachine['inputs'] = input.inputs,
  edits: RunMachine['edits'] = input.edits,
) {
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
  const unknown = inputs.find((i) => !slots.includes(i.slot));
  if (unknown) throw new DomainError(400, `The prompt has no {${unknown.slot}} slot.`);
  const empty = slots.find((slot) => !inputs.some((i) => i.slot === slot));
  if (empty) throw new DomainError(400, `Feed the {${empty}} slot first.`);
  const keys = inputs.map((i) => `${i.slot}\u0000${i.blockId}`);
  if (new Set(keys).size !== keys.length)
    throw new DomainError(400, 'A card may fill a slot only once.');
  const ordered = orderMachineInputs(template, inputs);
  const submission: SubmitRun = {
    braneId: input.braneId,
    key: input.key,
    model: input.model,
    prompt: template,
    references: ordered.map((i) => i.blockId),
    edits,
    maxOutputTokens: input.maxOutputTokens,
    maxReservedMicrousd: input.maxReservedMicrousd,
  };
  return {
    submission,
    machine: { blockId: placement.block_id, slots: ordered.map((i) => i.slot), placement },
  };
}
// The runs of a press that fans a slot out: the cards of the 'each' slot, one per run,
// each with every card of the other slots. A machine run admitted alone is one part.
// A comparison is one run per model, each with every input.
function machineParts(input: RunMachine): { inputs: RunMachine['inputs']; model: string }[] {
  if (input.models) {
    if (input.each)
      throw new DomainError(400, 'Compare models with the cards together, not one at a time.');
    return input.models.map((model) => ({ inputs: input.inputs, model }));
  }
  if (!input.each) return [{ inputs: input.inputs, model: input.model }];
  const fanned = input.inputs.filter((i) => i.slot === input.each);
  if (!fanned.length) throw new DomainError(400, `Feed the {${input.each}} slot first.`);
  if (fanned.length > MAX_EACH_RUNS)
    throw new DomainError(400, `One press runs each for at most ${MAX_EACH_RUNS} cards.`);
  const shared = input.inputs.filter((i) => i.slot !== input.each);
  return fanned.map((card) => ({ inputs: [...shared, card], model: input.model }));
}
// Run i of a batch has its own submission key, derived from the press's key.
function batchKey(key: string, position: number) {
  if (position === 0) return key;
  const hex = createHash('sha256').update(`${key}:${position}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
// The machine's tray: its newest output still on the table, or, when that output is in
// a group, this machine's outputs in that group in member order. The group is the
// machine's own (the stack an 'each' press made, or the cards an answer was split into)
// when every member came from this machine; otherwise it is shared, as a matrix is.
function machineTray(db: DB, machinePlacementId: string, each: boolean) {
  const newest = trayOutput(db, machinePlacementId);
  if (!newest) return { members: [] as Placement[], owned: false };
  const group = db
    .prepare<unknown[], { group_id: string }>(
      'SELECT group_id FROM group_members WHERE placement_id=?',
    )
    .get(newest.id);
  if (!group) return { members: comparedOutputs(db, newest), owned: false };
  const members = db
    .prepare<unknown[], Placement & { produced: number }>(
      `SELECT p.*,EXISTS(SELECT 1 FROM run_placements l WHERE l.anchor_placement_id=?
       AND (l.output_placement_id=p.id OR l.run_id IN (
         SELECT run_id FROM run_parts WHERE block_id=p.block_id))) produced
       FROM group_members m JOIN placements p ON p.id=m.placement_id
       WHERE m.group_id=? ORDER BY m.position`,
    )
    .all(machinePlacementId, group.group_id);
  const produced = members.filter((m) => m.produced).map(({ produced: _, ...p }) => p as Placement);
  const owned = produced.length === members.length;
  // A press together over a shared group replaces only the newest output in it.
  return {
    groupId: group.group_id,
    owned,
    members: owned || each ? produced : [newest],
  };
}
// A loose output of a comparison stands with the other outputs of its press still loose
// on the table, in the press's order; any other loose output stands alone.
function comparedOutputs(db: DB, output: Placement): Placement[] {
  const outputs = db
    .prepare<unknown[], Placement>(
      `SELECT p.* FROM run_placements l JOIN run_batches b ON b.run_id=l.run_id
       JOIN run_batches mate ON mate.batch_id=b.batch_id
       JOIN run_placements ml ON ml.run_id=mate.run_id
       JOIN placements p ON p.id=ml.output_placement_id
       WHERE l.output_placement_id=? AND p.host_placement_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM group_members WHERE placement_id=p.id)
       ORDER BY mate.position`,
    )
    .all(output.id);
  return outputs.length ? outputs : [output];
}
// Keep one output of a comparison: the press's other outputs still on the table go on
// its back, as a rerun's earlier outputs do.
export function keepOutput(db: DB, actor: string, runId: string) {
  return db.transaction(() => {
    const run = requireOwned(db, 'runs', actor, runId);
    canRunOnBrane(db, actor, run.brane_id);
    const kept = db
      .prepare<unknown[], Placement>(
        `SELECT p.* FROM run_placements l JOIN placements p ON p.id=l.output_placement_id
         WHERE l.run_id=? AND p.host_placement_id IS NULL`,
      )
      .get(runId);
    if (!kept) throw new DomainError(409, 'This answer is no longer on the table.');
    for (const other of comparedOutputs(db, kept))
      if (other.id !== kept.id) {
        // A machine fed from another answer of the comparison is now fed the kept one.
        moveFeeds(db, run.brane_id, { placementId: other.id }, { placementId: kept.id });
        retire(db, other, kept.id);
      }
  })();
}
// A tray card the new press has no place for goes on the back of the press's first
// output, without the links it had as a result on the table.
function retire(db: DB, placement: Placement, hostPlacementId: string) {
  const time = now();
  db.prepare('DELETE FROM group_members WHERE placement_id=?').run(placement.id);
  db.prepare('DELETE FROM feeds WHERE from_placement_id=?').run(placement.id);
  db.prepare('DELETE FROM relations WHERE from_placement_id=? OR to_placement_id=?').run(
    placement.id,
    placement.id,
  );
  db.prepare(
    'UPDATE placements SET host_placement_id=?,version=version+1,updated_at=? WHERE host_placement_id=?',
  ).run(hostPlacementId, time, placement.id);
  db.prepare(
    'UPDATE placements SET host_placement_id=?,version=version+1,updated_at=? WHERE id=?',
  ).run(hostPlacementId, time, placement.id);
}
// One press of a machine's lever. Fed together, it admits one run whose output takes
// the tray's place. Fed each, it admits one run per card in one transaction, all frozen
// and reserved at once or none: their outputs replace the tray stack's cards in order,
// or arrive as a new stack beside the machine.
export function runMachine(
  db: DB,
  snapshots: RevisionService,
  actor: string,
  input: RunMachine,
  limits: RunLimits,
) {
  return db.transaction(() => {
    machineSubmission(db, actor, input);
    const parts = machineParts(input);
    const batch = input.each || input.models ? { id: input.key } : undefined;
    const submit = (position: number, plan: OutputPlan) => {
      // Edits are applied once, before the first run; every run reads the saved text.
      const part = machineSubmission(db, actor, input, parts[position].inputs, []);
      return submitRun(
        db,
        snapshots,
        actor,
        { ...part.submission, model: parts[position].model, key: batchKey(input.key, position) },
        limits,
        undefined,
        part.machine,
        plan,
      );
    };
    // A repeated press returns the runs it admitted.
    if (
      db.prepare('SELECT 1 FROM runs WHERE owner_id=? AND submission_key=?').get(actor, input.key)
    ) {
      const runs = parts.map((_, position) => submit(position, replayPlan(batch, position)));
      return runs[0];
    }
    for (const model of new Set(parts.map((part) => part.model)))
      checkLimits(db, actor, model, limits);
    const placement = machineSubmission(db, actor, input).machine.placement;
    const tray = machineTray(db, placement.id, !!input.each);
    const appliedEdits = input.edits.map((edit) => ({
      blockId: edit.blockId,
      ...updateBlockLiveState(db, actor, edit),
    }));
    // New outputs past the tray's cards pile on the first one, as a stack does.
    // A comparison's outputs stand side by side from the first one.
    const first = tray.members[0] ?? childGeometry(db, placement);
    const runs = parts.map((_, position) => {
      const offset = Math.min(position, 3) * 10;
      return submit(position, {
        replaces: tray.members[position] ?? null,
        geometry: input.models
          ? {
              x: first.x + position * (first.width + 40),
              y: first.y,
              width: first.width,
              height: first.height,
            }
          : {
              x: first.x + offset,
              y: first.y + offset,
              width: first.width,
              height: first.height,
            },
        batch: batch && { ...batch, position },
        admitted: true,
        appliedEdits: position ? [] : appliedEdits,
      });
    });
    const outputs = runs.map((run) => outputPlacement(db, run.id));
    for (const surplus of tray.members.slice(parts.length)) retire(db, surplus, outputs[0]);
    if (!input.each) {
      // A run together, or a comparison, after its own stack leaves no stack behind.
      if (tray.groupId && tray.owned) {
        // What the stack fed, its one card now feeds.
        moveFeeds(db, input.braneId, { groupId: tray.groupId }, { placementId: outputs[0] });
        db.prepare('DELETE FROM groups WHERE id=?').run(tray.groupId);
      }
    } else if (tray.groupId) {
      const add = db.prepare(
        'INSERT INTO group_members VALUES (?,?,(SELECT coalesce(max(position),-1)+1 FROM group_members WHERE group_id=?))',
      );
      for (const output of outputs.slice(tray.members.length))
        add.run(tray.groupId, output, tray.groupId);
    } else {
      const groupId = uid();
      db.prepare('INSERT INTO groups VALUES (?,?,?,?,?)').run(
        groupId,
        input.braneId,
        `Each ${input.each}`.slice(0, 60),
        'stack',
        now(),
      );
      const add = db.prepare('INSERT INTO group_members VALUES (?,?,?)');
      outputs.forEach((output, position) => add.run(groupId, output, position));
      // What the one card fed, the stack that replaced it now feeds.
      moveFeeds(db, input.braneId, { placementId: outputs[0] }, { groupId });
    }
    return runs[0];
  })();
}
// A repeated press resolves to the runs it admitted; the plan is never applied again.
function replayPlan(batch: { id: string } | undefined, position: number): OutputPlan {
  return {
    replaces: null,
    geometry: { x: 0, y: 0, width: 1, height: 1 },
    batch: batch && { ...batch, position },
    admitted: true,
    appliedEdits: [],
  };
}
function outputPlacement(db: DB, runId: string) {
  return (
    db.prepare('SELECT output_placement_id FROM run_placements WHERE run_id=?').get(runId) as {
      output_placement_id: string;
    }
  ).output_placement_id;
}
export function estimateMachine(db: DB, actor: string, input: RunMachine, limits: RunLimits) {
  machineSubmission(db, actor, input);
  const estimates = machineParts(input).map((part, position) => {
    const { submission, machine } = machineSubmission(
      db,
      actor,
      input,
      part.inputs,
      position ? [] : input.edits,
    );
    return estimateRun(db, actor, { ...submission, model: part.model }, limits, machine);
  });
  // The press reserves every run's bound at once, so it is affordable only in total.
  const reserved = estimates.reduce((sum, e) => sum + e.reservedMicrousd, 0);
  return {
    ...estimates[0],
    runs: estimates.length,
    estimatedInputTokens: estimates.reduce((sum, e) => sum + e.estimatedInputTokens, 0),
    reservedMicrousd: reserved,
    canAfford:
      estimates.every((e) => e.canAfford) && reserved <= estimates[0].budget.availableMicrousd,
  };
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
