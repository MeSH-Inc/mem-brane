import { expect, it } from 'vitest';
import {
  operationDependencies,
  requiredOperations,
  requestResources,
} from '../src/services/command-dependencies';
import type { PendingOperation } from '../src/services/replica-storage';
const geometry = { x: 0, y: 0, width: 320, height: 220 };
const operations: PendingOperation[] = [
  { key: 'brane', command: { type: 'brane.create', id: 'b', title: 'B' } },
  { key: 'title', command: { type: 'brane.title', id: 'b', title: 'Next', previous: 'B' } },
  {
    key: 'text',
    command: { type: 'text.create', braneId: 'b', blockId: 'a', placementId: 'p', geometry },
  },
  { key: 'edit', command: { type: 'text.edit', blockId: 'a', text: 'A', version: 0 } },
  { key: 'move', command: { type: 'placement.edit', id: 'p', ...geometry, version: 0 } },
  { key: 'remove', command: { type: 'placement.remove', id: 'p', braneId: 'b', version: 1 } },
];
it('preserves creation and entity order without coupling title, text and geometry', () => {
  const graph = operationDependencies(operations);
  expect([...graph.get('text')!]).toEqual(['brane']);
  expect([...graph.get('edit')!]).toEqual(['text']);
  expect([...graph.get('move')!]).toEqual(['text']);
  expect([...graph.get('remove')!]).toEqual(['text', 'move']);
  expect(
    requiredOperations(operations, requestResources('/runs', { braneId: 'b', references: ['a'] })),
  ).toEqual(['brane', 'text', 'edit']);
  expect(
    requiredOperations(
      operations,
      requestResources('/artifacts/spawn', {
        braneId: 'b',
        sourceBlockIds: ['a'],
        anchorPlacementId: 'p',
      }),
    ),
  ).toEqual(['brane', 'text', 'edit', 'move', 'remove']);
  expect(requestResources('/runs/id/cancel', {})).toEqual([]);
  expect(requestResources('/runs/id/retry', { key: 'retry' })).toEqual([]);
});
