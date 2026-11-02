import type { BraneState, Feed, Run } from '../../shared/types/domain';
import {
  machineDependencies,
  machineName,
  machineSlots,
  type MachineInput,
} from '../../shared/machines';

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
  // A run's sources are listed once for each card its answer became; its own output's
  // list is the one that counts.
  const frozenOf = (run: Run) =>
    scene.derivations
      .filter((d) => d.runId === run.id && d.outputBlockId === run.output_block_id)
      .sort((a, b) => a.position - b.position);
  const frozen = batch.flatMap(frozenOf);
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
      frozenOf(run)
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

// What a machine's tray holds: its newest output on the table, as one card; or, when
// every card of the group that output stands in came from this machine (an each press,
// or an answer split into cards), that group. None if the machine has not run.
export function machineTray(
  state: Pick<BraneState, 'placements' | 'groups' | 'runs' | 'parts' | 'derivations'>,
  machinePlacementId: string,
): { placementId: string } | { groupId: string } | null {
  const runIds = new Set(
    state.derivations.filter((d) => d.anchorPlacementId === machinePlacementId).map((d) => d.runId),
  );
  const runs = new Map(state.runs.filter((r) => runIds.has(r.id)).map((r) => [r.id, r]));
  const producer = new Map<string, Run>();
  for (const run of runs.values()) producer.set(run.output_block_id, run);
  for (const part of state.parts) {
    const run = runs.get(part.runId);
    if (run) producer.set(part.blockId, run);
  }
  const produced = state.placements.filter((p) => !p.host_placement_id && producer.has(p.block_id));
  if (!produced.length) return null;
  const newest = produced.reduce((a, b) =>
    producer.get(b.block_id)!.created_at > producer.get(a.block_id)!.created_at ? b : a,
  );
  const group = state.groups.find((g) => g.members.includes(newest.id));
  const own = new Set(produced.map((p) => p.id));
  if (group && group.members.every((id) => own.has(id))) return { groupId: group.id };
  return { placementId: newest.id };
}

const ACTIVE_RUN = new Set(['queued', 'claimed', 'running', 'cancel_requested']);
type ChainScene = MachineScene & Pick<BraneState, 'parts'>;

// Which machine's tray each feed source is: a card or group key (a placement id, or
// "group:" and a group id) to the machine placement whose tray it is now.
export function trayOwners(scene: ChainScene) {
  const machines = new Set(scene.blocks.filter((b) => b.kind === 'machine').map((b) => b.id));
  const owners = new Map<string, string>();
  for (const placement of scene.placements) {
    if (!machines.has(placement.block_id) || placement.host_placement_id) continue;
    const tray = machineTray(scene, placement.id);
    if (tray)
      owners.set('groupId' in tray ? `group:${tray.groupId}` : tray.placementId, placement.id);
  }
  return owners;
}

// A machine's place in a chain. It waits on the first machine upstream, in feeding
// order, that is stale or running: that machine's answer will change what this one is
// fed. The chain is what one press reruns, in order: every machine upstream that is
// stale or fed by one that will rerun, then this one.
export interface MachineChain {
  waitingOn: { placementId: string; name: string; running: boolean } | null;
  chain: string[];
}
export function machineChain(scene: ChainScene, machinePlacementId: string): MachineChain {
  const { edges } = machineDependencies(scene);
  const producersOf = (machine: string) => [
    ...new Set(edges.filter((e) => e.consumer === machine).map((e) => e.producer)),
  ];
  // Every machine upstream, ordered so a producer comes before what it feeds.
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visit = (machine: string) => {
    if (ordered.includes(machine) || visiting.has(machine)) return;
    visiting.add(machine);
    for (const producer of producersOf(machine)) visit(producer);
    ordered.push(machine);
  };
  visit(machinePlacementId);
  const upstream = ordered.filter((machine) => machine !== machinePlacementId);
  const anchored = new Map<string, string>();
  for (const d of scene.derivations)
    if (d.anchorPlacementId) anchored.set(d.runId, d.anchorPlacementId);
  const running = new Set(
    scene.runs.filter((r) => ACTIVE_RUN.has(r.status)).flatMap((r) => anchored.get(r.id) ?? []),
  );
  const stale = (machine: string) => machineStaleness(scene, machine).stale;
  const rerun = new Set<string>();
  for (const machine of upstream)
    if (stale(machine) || running.has(machine) || producersOf(machine).some((p) => rerun.has(p)))
      rerun.add(machine);
  const first = upstream.find((machine) => stale(machine) || running.has(machine));
  if (!first) return { waitingOn: null, chain: [machinePlacementId] };
  const busy = upstream.find((machine) => running.has(machine));
  const block = scene.blocks.find(
    (b) => b.id === scene.placements.find((p) => p.id === (busy ?? first))?.block_id,
  );
  return {
    waitingOn: {
      placementId: busy ?? first,
      name: machineName(block?.content.text ?? ''),
      running: !!busy,
    },
    chain: [...upstream.filter((machine) => rerun.has(machine)), machinePlacementId],
  };
}

// One press of a machine's lever: the runs it admitted, together, each, or one per
// compared model.
export interface Press {
  id: string;
  created_at: number;
  models: string[];
  runs: number;
  // Each status among the press's runs, with how many runs have it.
  statuses: [string, number][];
  // The press's cost, once every run's usage is settled.
  confirmed_microusd: number | null;
}
const anchors = (scene: Pick<BraneState, 'derivations'>) => {
  const anchored = new Map<string, string>();
  for (const d of scene.derivations)
    if (d.anchorPlacementId) anchored.set(d.runId, d.anchorPlacementId);
  return anchored;
};
// A machine's presses, newest first.
export function machinePresses(
  scene: Pick<BraneState, 'runs' | 'derivations'>,
  machinePlacementId: string,
): Press[] {
  const anchored = anchors(scene);
  const presses = new Map<string, Press>();
  for (const run of scene.runs) {
    if (anchored.get(run.id) !== machinePlacementId) continue;
    const id = run.batch_id ?? run.id;
    const press = presses.get(id) ?? {
      id,
      created_at: run.created_at,
      models: [],
      runs: 0,
      statuses: [],
      confirmed_microusd: 0,
    };
    press.created_at = Math.min(press.created_at, run.created_at);
    if (!press.models.includes(run.model)) press.models.push(run.model);
    press.runs += 1;
    const status = press.statuses.find(([name]) => name === run.status);
    if (status) status[1] += 1;
    else press.statuses.push([run.status, 1]);
    press.confirmed_microusd =
      press.confirmed_microusd === null || run.confirmed_microusd === null
        ? null
        : press.confirmed_microusd + run.confirmed_microusd;
    presses.set(id, press);
  }
  return [...presses.values()].sort((a, b) => b.created_at - a.created_at);
}

// What a machine's newest answer was made from: its last press and, for every card that
// press read which another machine wrote, that machine's press, and so on upstream.
// Upstream first; a machine appears once, at the press its answer came from.
export function chainReceipt(scene: ChainScene, machinePlacementId: string) {
  const anchored = anchors(scene);
  const producer = new Map<string, Run>();
  for (const run of scene.runs) producer.set(run.output_block_id, run);
  const byId = new Map(scene.runs.map((r) => [r.id, r]));
  for (const part of scene.parts) {
    const run = byId.get(part.runId);
    if (run) producer.set(part.blockId, run);
  }
  const receipt: { placementId: string; name: string; press: Press }[] = [];
  const seen = new Set<string>();
  const visit = (machine: string, run: Run) => {
    const pressId = run.batch_id ?? run.id;
    if (seen.has(machine)) return;
    seen.add(machine);
    const runs = scene.runs.filter((r) => (r.batch_id ?? r.id) === pressId);
    for (const pressed of runs)
      for (const d of scene.derivations)
        if (d.runId === pressed.id && d.outputBlockId === pressed.output_block_id) {
          const made = producer.get(d.sourceBlockId);
          const upstream = made && anchored.get(made.id);
          if (made && upstream && upstream !== machine) visit(upstream, made);
        }
    const press = machinePresses({ runs, derivations: scene.derivations }, machine)[0];
    const block = scene.blocks.find(
      (b) => b.id === scene.placements.find((p) => p.id === machine)?.block_id,
    );
    if (press)
      receipt.push({ placementId: machine, name: machineName(block?.content.text ?? ''), press });
  };
  const last = scene.runs.filter((r) => anchored.get(r.id) === machinePlacementId).at(-1);
  if (last) visit(machinePlacementId, last);
  return receipt;
}

// Machines in feeding order: a machine after every machine that feeds it.
export function feedingOrder(scene: ChainScene, machines: Iterable<string>) {
  const { edges } = machineDependencies(scene);
  const wanted = new Set(machines);
  const ordered: string[] = [];
  const visit = (machine: string, path: Set<string>) => {
    if (ordered.includes(machine) || path.has(machine)) return;
    path.add(machine);
    for (const edge of edges) if (edge.consumer === machine) visit(edge.producer, path);
    path.delete(machine);
    if (wanted.has(machine)) ordered.push(machine);
  };
  for (const machine of wanted) visit(machine, new Set());
  return ordered;
}

// The machines kept current that are due: stale, or waiting on a machine upstream. The
// due run is every one of their chains, together, in feeding order; it waits while any
// machine in it is running.
export function dueMachines(scene: ChainScene & Pick<BraneState, 'keptCurrent'>) {
  const placed = new Set(scene.placements.filter((p) => !p.host_placement_id).map((p) => p.id));
  const due: string[] = [];
  const chained = new Set<string>();
  let waitingOn: MachineChain['waitingOn'] = null;
  for (const machine of scene.keptCurrent) {
    if (!placed.has(machine)) continue;
    const chain = machineChain(scene, machine);
    if (!chain.waitingOn && !machineStaleness(scene, machine).stale) continue;
    due.push(machine);
    for (const member of chain.chain) chained.add(member);
    if (chain.waitingOn?.running) waitingOn = chain.waitingOn;
  }
  return { due, run: feedingOrder(scene, chained), waitingOn };
}
