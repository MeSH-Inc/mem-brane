import type { BraneState } from '../../shared/types/domain';
// Resolve presentation instances without turning placement IDs into provenance.
export function derivationEdges(state: Pick<BraneState, 'placements' | 'derivations'>) {
  const ordinals = new Map<string, number>();
  return state.derivations.flatMap((d) => {
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
