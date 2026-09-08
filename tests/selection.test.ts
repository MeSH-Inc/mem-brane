import { expect, it } from 'vitest';
import { selectedBlockIds } from '../src/canvas/selection';
import type { Placement } from '../shared/types/domain';
it('resolves unique context blocks and ignores missing placements', () => {
  const placements: Placement[] = ['pa', 'pa2', 'pb'].map((id, i) => ({
    id,
    block_id: i === 2 ? 'b' : 'a',
    brane_id: 'brane',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    z_index: 0,
    version: 0,
  }));
  expect(selectedBlockIds(placements, ['pa2', 'pa', 'pb', 'missing'])).toEqual(['a', 'b']);
  expect(selectedBlockIds(placements, ['missing'])).toEqual([]);
});
