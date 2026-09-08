import type { Revision, Run } from './domain';

export interface RevisionPage {
  items: Revision[];
  nextCursor: string | null;
}
export interface RunPage {
  items: Omit<Run, 'partial'>[];
  nextCursor: string | null;
}
