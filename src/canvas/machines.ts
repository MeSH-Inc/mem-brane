import type { BraneState, Feed } from '../../shared/types/domain';
import { machineSlots, type MachineInput } from '../../shared/machines';

type MachineScene = Pick<BraneState, 'blocks' | 'placements' | 'feeds' | 'runs' | 'derivations'>;

export interface MachineView {
  slots: string[];
  // Current feeds that name a slot of the current template, in slot then feed order.
  inputs: (MachineInput & { feedId: string; placementId: string })[];
  missingSlots: string[];
  lastRunId: string | null;
  ran: boolean;
  stale: boolean;
  templateChanged: boolean;
  // Slots whose fed cards, or those cards' versions, differ from the last run.
  changedSlots: string[];
  // Feeds whose card changed since the last run froze it.
  changedFeeds: string[];
}

// Staleness compares what a run would send now with what the last run froze:
// the machine's template version, and per slot the fed blocks and their versions.
// It is a projection; nothing is stored and nothing reruns.
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
  const placementBlock = new Map(scene.placements.map((p) => [p.id, p.block_id]));
  const blockVersion = new Map(scene.blocks.map((b) => [b.id, b]));
  const inputs = slots.flatMap((slot) =>
    scene.feeds
      .filter((f) => f.to_placement_id === machinePlacementId && f.slot === slot)
      .flatMap((f: Feed) => {
        const blockId = placementBlock.get(f.from_placement_id);
        return blockId ? [{ blockId, slot, feedId: f.id, placementId: f.from_placement_id }] : [];
      }),
  );
  const missingSlots = slots.filter((slot) => !inputs.some((i) => i.slot === slot));
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
      missingSlots,
      lastRunId: null,
      ran: false,
      stale: false,
      templateChanged: false,
      changedSlots: [],
      changedFeeds: [],
    };
  const frozen = scene.derivations.filter((d) => d.runId === lastRun.id);
  // Generated blocks are immutable: their frozen version is null and identity suffices.
  const current = (blockId: string) => {
    const b = blockVersion.get(blockId);
    return b?.origin === 'generated' ? null : (b?.version ?? null);
  };
  const changedFeeds = inputs
    .filter((input) => {
      const was = frozen.find((d) => d.label === input.slot && d.sourceBlockId === input.blockId);
      return !was || was.sourceVersion !== current(input.blockId);
    })
    .map((input) => input.feedId);
  const changedSlots = slots.filter((slot) => {
    const now = inputs
      .filter((i) => i.slot === slot)
      .map((i) => `${i.blockId}@${current(i.blockId)}`);
    const then = frozen
      .filter((d) => d.label === slot)
      .map((d) => `${d.sourceBlockId}@${d.sourceVersion}`);
    return now.length !== then.length || now.some((key, index) => key !== then[index]);
  });
  const templateChanged =
    lastRun.machine_version !== block.version ||
    (draftTemplate !== undefined && draftTemplate !== block.content.text);
  return {
    slots,
    inputs,
    missingSlots,
    lastRunId: lastRun.id,
    ran: true,
    stale: templateChanged || changedSlots.length > 0,
    templateChanged,
    changedSlots,
    changedFeeds,
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
