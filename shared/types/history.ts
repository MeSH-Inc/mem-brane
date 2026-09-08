import type { Revision } from './domain';

export interface RevisionPage {
  items: Revision[];
  nextCursor: string | null;
}
