import type { Block } from '../../shared/types/domain';
// One user-facing name per kind of card.
export function cardKind(block: Pick<Block, 'origin' | 'kind'>) {
  if (block.origin === 'generated') return 'Response';
  return { webpage: 'Web clipping', pdf: 'PDF', image: 'Image', text: 'Thought' }[block.kind];
}

// Plain run status words; the technical status stays in data and tests.
export const statusLabels: Record<string, string> = {
  queued: 'waiting',
  claimed: 'starting',
  running: 'writing',
  cancel_requested: 'stopping',
  completed: 'done',
  failed: 'failed',
  interrupted: 'interrupted',
  cancelled: 'stopped',
};
