import { z } from 'zod';

export const MAX_RELATION_LABEL = 60;
export const relationLabel = z.string().trim().min(1).max(MAX_RELATION_LABEL);
// The words offered when an arrow is drawn; any other word may be typed.
export const RELATION_LABELS = ['answers', 'supports', 'contradicts', 'extends'] as const;

// The frozen text of a relation entry. Each end is named by the label its card has in
// the run, with its frozen revision when two inputs share a label.
export function relationText(label: string, from: string, to: string) {
  return `${from} ${label} ${to}.`;
}
