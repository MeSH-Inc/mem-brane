import type { BraneState } from '../../shared/types/domain';
// Resolve presentation instances without turning placement IDs into provenance.
export function derivationEdges(state: Pick<BraneState, 'placements' | 'derivations'>) {
  return state.derivations.flatMap((d) => {
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
        label: 'spawned from',
        selectable: false,
        deletable: false,
        style: { stroke: '#777b60', strokeWidth: 1.5 },
      },
    ];
  });
}
