import type { BlockKind, Run } from './domain';

export interface RevisionSummary {
  id: string;
  block_id: string;
  created_at: number;
  format: BlockKind;
  preview: string;
}
export interface RevisionPage {
  items: RevisionSummary[];
  nextCursor: string | null;
}
export interface RunPage {
  items: Omit<
    Run,
    'partial' | 'machine_block_id' | 'machine_version' | 'batch_id' | 'batch_position'
  >[];
  nextCursor: string | null;
}
