import type { Edge } from '@xyflow/react';
import type { BraneState } from '../../shared/types/domain';
// Resolve presentation instances without turning placement IDs into provenance.
export function derivationEdges(
  state: Pick<BraneState, 'placements' | 'derivations'>,
  machineRuns: Set<string> = new Set(),
): Edge[] {
  const ordinals = new Map<string, number>();
  const trays = new Set<string>();
  return state.derivations.flatMap((d): Edge[] => {
    // A machine run draws one line from the machine's tray to its output; its inputs
    // are already drawn as feeds.
    if (machineRuns.has(d.runId)) {
      const output =
        state.placements.find((p) => p.id === d.outputPlacementId) ??
        state.placements.find((p) => p.block_id === d.outputBlockId);
      const machine = state.placements.find((p) => p.id === d.anchorPlacementId);
      if (!output || !machine || trays.has(d.runId)) return [];
      trays.add(d.runId);
      return [
        {
          id: `${d.runId}:tray`,
          source: machine.id,
          target: output.id,
          sourceHandle: 'output',
          targetHandle: 'input',
          type: 'smoothstep',
          selectable: false,
          deletable: false,
          className: 'tray-edge',
          style: { stroke: '#3f5a45', strokeWidth: 2 },
        },
      ];
    }
    const ordinal = (ordinals.get(`${d.runId}:${d.kind}`) ?? 0) + 1;
    ordinals.set(`${d.runId}:${d.kind}`, ordinal);
    const sources = state.placements.filter((p) => p.block_id === d.sourceBlockId);
    const outputs = state.placements.filter((p) => p.block_id === d.outputBlockId);
    const source = sources.find((p) => p.id === d.anchorPlacementId) ?? sources[0];
    const output = outputs.find((p) => p.id === d.outputPlacementId) ?? outputs[0];
    if (!source || !output) return [];
    return [
      {
        id: `${d.runId}:${d.position}`,
        source: source.id,
        target: output.id,
        sourceHandle: 'output',
        targetHandle: 'input',
        type: 'smoothstep',
        label: d.kind === 'source' ? 'developed' : `context ${ordinal}`,
        selectable: false,
        deletable: false,
        style: { stroke: '#777b60', strokeWidth: 1.5 },
      },
    ];
  });
}

// Feeds are authored inputs: a card's output, or a group's frame, to a machine's slot. A
// feed whose cards changed since the machine's last run is drawn dashed in the stale
// colour.
export function machineEdges(
  state: Pick<BraneState, 'placements' | 'feeds' | 'groups'>,
  changedFeeds: Set<string> = new Set(),
): Edge[] {
  const placed = new Set(state.placements.map((p) => p.id));
  const groups = new Set(state.groups.map((g) => g.id));
  return state.feeds.flatMap((f) => {
    const source = f.from_group_id
      ? groups.has(f.from_group_id) && groupNodeId(f.from_group_id)
      : placed.has(f.from_placement_id!) && f.from_placement_id!;
    if (!source || !placed.has(f.to_placement_id)) return [];
    return [
      {
        id: `feed:${f.id}`,
        source,
        target: f.to_placement_id,
        sourceHandle: 'output',
        targetHandle: `slot:${f.slot}`,
        type: 'default',
        selectable: false,
        deletable: false,
        className: changedFeeds.has(f.id) ? 'feed-edge stale' : 'feed-edge',
        style: changedFeeds.has(f.id)
          ? { stroke: '#c98a1b', strokeWidth: 2, strokeDasharray: '6 4' }
          : { stroke: '#7d8a7e', strokeWidth: 2 },
      },
    ];
  });
}
export const groupNodeId = (groupId: string) => `group:${groupId}`;
