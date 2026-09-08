import type { Placement } from '../../shared/types/domain';

export function selectedBlockIds(placements: Placement[], selectedPlacementIds: string[]) {
  const selected = new Set(selectedPlacementIds);
  return [...new Set(placements.filter((p) => selected.has(p.id)).map((p) => p.block_id))];
}
