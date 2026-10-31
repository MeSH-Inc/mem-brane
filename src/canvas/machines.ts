import type { BraneState, Feed, Run } from '../../shared/types/domain';
import { machineSlots, type MachineInput } from '../../shared/machines';

type MachineScene = Pick<
  BraneState,
  | 'blocks'
  | 'placements'
  | 'feeds'
  | 'groups'
  | 'relations'
  | 'runs'
  | 'derivations'
  | 'relationEntries'
>;

export interface MachineView {
  slots: string[];
  // Current inputs for slots of the current template, in slot then feed order; a fed
  // group contributes its members in member order, all under the group's feed.
  inputs: (MachineInput & { feedId: string; placementId: string })[];
  // The feeds behind those inputs, once each: what a slot row lists.
  feeds: {
    feedId: string;
    slot: string;
    groupId: string | null;
    count: number;
    mode: 'together' | 'each';
  }[];
  // The slot whose cards each get their own run, if a group feeds it 'each'; and how many
  // runs the lever's press admits.
  eachSlot: string | null;
  runs: number;
  // More than one slot is fed 'each'; the lever cannot fan out over two lists at once.
  eachConflict: boolean;
  missingSlots: string[];
  lastRunId: string | null;
  ran: boolean;
  stale: boolean;
  templateChanged: boolean;
  // Slots whose fed cards, or those cards' versions, differ from the last run.
  changedSlots: string[];
  // Feeds whose card, or one of whose group's cards, changed since the last run froze it.
  changedFeeds: string[];
  // The arrows between the inputs differ from those the last run sent.
  arrowsChanged: boolean;
}

// The arrows a run over these input blocks sends: those whose two ends are both inputs,
// by block and word, as the server freezes them.
export function sentArrows(
  scene: Pick<BraneState, 'placements' | 'relations'>,
  inputBlockIds: Iterable<string>,
): string[] {
  const inputs = new Set(inputBlockIds);
  const block = new Map(
    scene.placements.filter((p) => !p.host_placement_id).map((p) => [p.id, p.block_id]),
  );
  const keys = scene.relations.flatMap((r) => {
    const from = block.get(r.from_placement_id),
      to = block.get(r.to_placement_id);
    return from && to && from !== to && inputs.has(from) && inputs.has(to)
      ? [`${from}>${to}:${r.label}`]
      : [];
  });
  return [...new Set(keys)].sort();
}
export function frozenArrows(scene: Pick<BraneState, 'relationEntries'>, runId: string) {
  return [
    ...new Set(
      scene.relationEntries
        .filter((e) => e.runId === runId)
        .map((e) => `${e.fromBlockId}>${e.toBlockId}:${e.label}`),
    ),
  ].sort();
}
const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((key, index) => key === b[index]);

// An answer is stale when what asking again would send differs from what its run froze:
// a source's text, or the arrows between its sources.
export function answerStaleness(
  scene: Pick<
    BraneState,
    'blocks' | 'placements' | 'relations' | 'runs' | 'derivations' | 'relationEntries' | 'parts'
  >,
  outputBlockId: string,
) {
  // A card an answer was split into is that run's output as much as the answer is.
  const runId = scene.parts.find((p) => p.blockId === outputBlockId)?.runId;
  const run = scene.runs.find((r) =>
    runId ? r.id === runId : r.output_block_id === outputBlockId,
  );
  const frozen = scene.derivations.filter((d) => d.outputBlockId === outputBlockId);
  const version = new Map(scene.blocks.map((b) => [b.id, b.version]));
  const sourcesChanged = frozen.some(
    (d) =>
      d.sourceVersion !== null &&
      version.has(d.sourceBlockId) &&
      version.get(d.sourceBlockId) !== d.sourceVersion,
  );
  const arrowsChanged =
    !!run &&
    !sameList(
      sentArrows(
        scene,
        frozen.map((d) => d.sourceBlockId),
      ),
      frozenArrows(scene, run.id),
    );
  return { sourcesChanged, arrowsChanged, stale: sourcesChanged || arrowsChanged };
}

// Staleness compares what a run would send now with what the last run froze:
// the machine's template version, per slot the fed blocks and their versions, and the
// arrows between the fed cards. It is a projection; nothing is stored and nothing reruns.
// An unsaved template draft decides the slots, exactly as the run will freeze it.
export function machineStaleness(
  scene: MachineScene,
  machinePlacementId: string,
  draftTemplate?: string,
): MachineView {
  const placement = scene.placements.find((p) => p.id === machinePlacementId);
  const block = placement && scene.blocks.find((b) => b.id === placement.block_id);
  const template = block?.kind === 'machine' ? (draftTemplate ?? block.content.text) : '';
  const slots = machineSlots(template);
  const placementBlock = new Map(
    scene.placements.filter((p) => !p.host_placement_id).map((p) => [p.id, p.block_id]),
  );
  const blockVersion = new Map(scene.blocks.map((b) => [b.id, b]));
  const groups = new Map(scene.groups.map((g) => [g.id, g]));
  const feeds: MachineView['feeds'] = [];
  const inputs = slots.flatMap((slot) => {
    const seen = new Set<string>();
    return scene.feeds
      .filter((f) => f.to_placement_id === machinePlacementId && f.slot === slot)
      .flatMap((f: Feed) => {
        const sources = f.from_group_id
          ? (groups.get(f.from_group_id)?.members ?? [])
          : [f.from_placement_id!];
        // A card fed both alone and in a group fills the slot once, at its first feed.
        const fed = sources.flatMap((placementId) => {
          const blockId = placementBlock.get(placementId);
          if (!blockId || blockVersion.get(blockId)?.kind === 'machine' || seen.has(placementId))
            return [];
          seen.add(placementId);
          return [{ blockId, slot, feedId: f.id, placementId }];
        });
        if (fed.length || f.from_group_id)
          feeds.push({
            feedId: f.id,
            slot,
            groupId: f.from_group_id,
            count: fed.length,
            mode: f.mode,
          });
        return fed;
      });
  });
  const missingSlots = slots.filter((slot) => !inputs.some((i) => i.slot === slot));
  const eachSlots = [...new Set(feeds.filter((f) => f.mode === 'each').map((f) => f.slot))];
  const eachSlot = eachSlots[0] ?? null;
  // What one press sends: one list of inputs, or one per card of the 'each' slot.
  const parts = eachSlot
    ? inputs
        .filter((i) => i.slot === eachSlot)
        .map((card) => inputs.filter((i) => i.slot !== eachSlot || i === card))
    : [inputs];
  const fanned = {
    eachSlot,
    runs: Math.max(parts.length, 1),
    eachConflict: eachSlots.length > 1,
  };
  const lastRun = block
    ? scene.runs
        .filter((r) => r.machine_block_id === block.id)
        .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
        .at(-1)
    : undefined;
  if (!block || !lastRun)
    return {
      slots,
      inputs,
      feeds,
      ...fanned,
      missingSlots,
      lastRunId: null,
      ran: false,
      stale: false,
      templateChanged: false,
      changedSlots: [],
      changedFeeds: [],
      arrowsChanged: false,
    };
  // The last press: every run of its batch, the newest at each position (a retry
  // replaces its run), in position order. A comparison's runs all froze the same inputs
  // for different models, so what it sent is what its first run sent.
  const pressed = lastRun.batch_id
    ? [
        ...scene.runs
          .filter((r) => r.batch_id === lastRun.batch_id)
          .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
          .reduce((byPosition, r) => byPosition.set(r.batch_position!, r), new Map<number, Run>())
          .entries(),
      ]
        .sort(([a], [b]) => a - b)
        .map(([, r]) => r)
    : [lastRun];
  const batch = new Set(pressed.map((r) => r.model)).size > 1 ? pressed.slice(0, 1) : pressed;
  const batchIds = new Set(batch.map((r) => r.id));
  const frozen = scene.derivations.filter((d) => batchIds.has(d.runId));
  const frozenOf = (runId: string) =>
    scene.derivations.filter((d) => d.runId === runId).sort((a, b) => a.position - b.position);
  // Generated blocks are immutable: their frozen version is null and identity suffices.
  const current = (blockId: string) => {
    const b = blockVersion.get(blockId);
    return b?.origin === 'generated' ? null : (b?.version ?? null);
  };
  const changedFeeds = [
    ...new Set(
      inputs
        .filter((input) => {
          const was = frozen.find(
            (d) => d.label === input.slot && d.sourceBlockId === input.blockId,
          );
          return !was || was.sourceVersion !== current(input.blockId);
        })
        .map((input) => input.feedId),
    ),
  ];
  // Per slot, what every run of the press would send, run after run, against what the
  // last press's runs froze; a change of mode changes how often each slot is sent.
  const changedSlots = slots.filter((slot) => {
    const now = parts.flatMap((part) =>
      part.filter((i) => i.slot === slot).map((i) => `${i.blockId}@${current(i.blockId)}`),
    );
    const then = batch.flatMap((run) =>
      frozenOf(run.id)
        .filter((d) => d.label === slot)
        .map((d) => `${d.sourceBlockId}@${d.sourceVersion}`),
    );
    return now.length !== then.length || now.some((key, index) => key !== then[index]);
  });
  // A group feed that lost cards changes its slot without naming a changed card.
  for (const feed of feeds)
    if (changedSlots.includes(feed.slot) && feed.groupId && !changedFeeds.includes(feed.feedId))
      changedFeeds.push(feed.feedId);
  const templateChanged =
    lastRun.machine_version !== block.version ||
    (draftTemplate !== undefined && draftTemplate !== block.content.text);
  const arrowsChanged = !sameList(
    parts.flatMap((part) =>
      sentArrows(
        scene,
        part.map((i) => i.blockId),
      ),
    ),
    batch.flatMap((run) => frozenArrows(scene, run.id)),
  );
  return {
    slots,
    inputs,
    feeds,
    ...fanned,
    missingSlots,
    lastRunId: lastRun.id,
    ran: true,
    stale: templateChanged || changedSlots.length > 0 || arrowsChanged,
    templateChanged,
    changedSlots,
    changedFeeds,
    arrowsChanged,
  };
}

// Slide right from the preferred point until a new card would overlap no placement,
// so a new machine never lands on the cards it is meant to be fed from.
export function openSpot(
  placements: { x: number; y: number; width: number; height: number }[],
  point: { x: number; y: number },
  width: number,
  height: number,
) {
  const gap = 40;
  let x = point.x;
  for (let attempt = 0; attempt < 200; attempt++) {
    const blocker = placements.find(
      (p) =>
        x < p.x + p.width + gap &&
        x + width + gap > p.x &&
        point.y < p.y + p.height + gap &&
        point.y + height + gap > p.y,
    );
    if (!blocker) break;
    x = blocker.x + blocker.width + gap;
  }
  return { x, y: point.y, width, height };
}
