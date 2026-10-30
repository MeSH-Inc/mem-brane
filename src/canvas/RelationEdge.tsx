import { memo, useEffect, useRef, useState } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  MarkerType,
  getStraightPath,
  useInternalNode,
  type Edge,
  type EdgeProps,
  type InternalNode,
} from '@xyflow/react';
import type { BraneState } from '../../shared/types/domain';
import { RELATION_LABELS, MAX_RELATION_LABEL } from '../../shared/relations';

export type RelationData = { label: string; onRemove: (relationId: string) => void };
export type RelationEdgeType = Edge<RelationData, 'relation'>;

// Where the line from a card's centre toward a point leaves the card's border.
function border(node: InternalNode, toward: { x: number; y: number }) {
  const width = node.measured.width ?? 0,
    height = node.measured.height ?? 0;
  const x = node.internals.positionAbsolute.x + width / 2,
    y = node.internals.positionAbsolute.y + height / 2;
  const dx = toward.x - x,
    dy = toward.y - y;
  const scale = Math.min(
    dx ? Math.abs(width / 2 / dx) : Infinity,
    dy ? Math.abs(height / 2 / dy) : Infinity,
  );
  return { x: x + dx * scale, y: y + dy * scale };
}
const centre = (node: InternalNode) => ({
  x: node.internals.positionAbsolute.x + (node.measured.width ?? 0) / 2,
  y: node.internals.positionAbsolute.y + (node.measured.height ?? 0) / 2,
});

// An arrow between two cards on the table: a straight line between their nearest
// borders, whichever way they stand, labelled with its word. The label carries the
// arrow's one action, removing it.
export const RelationEdge = memo(function RelationEdge({
  id,
  source,
  target,
  data,
  markerEnd,
}: EdgeProps<RelationEdgeType>) {
  const from = useInternalNode(source),
    to = useInternalNode(target);
  if (!from || !to) return null;
  const start = border(from, centre(to)),
    end = border(to, centre(from));
  const [path, x, y] = getStraightPath({
    sourceX: start.x,
    sourceY: start.y,
    targetX: end.x,
    targetY: end.y,
  });
  const relationId = id.slice('relation:'.length);
  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} className="relation-edge" />
      <EdgeLabelRenderer>
        <span
          className="relation-label nodrag nopan"
          data-canvas-native
          style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
        >
          {data?.label}
          <button
            className="text-button"
            aria-label={`Remove arrow “${data?.label}”`}
            title="Remove this arrow"
            onClick={() => data?.onRemove(relationId)}
          >
            ×
          </button>
        </span>
      </EdgeLabelRenderer>
    </>
  );
});

export function relationEdges(
  state: Pick<BraneState, 'placements' | 'relations'>,
  onRemove: (relationId: string) => void,
): RelationEdgeType[] {
  const table = new Set(state.placements.filter((p) => !p.host_placement_id).map((p) => p.id));
  return state.relations
    .filter((r) => table.has(r.from_placement_id) && table.has(r.to_placement_id))
    .map((r) => ({
      id: `relation:${r.id}`,
      type: 'relation',
      source: r.from_placement_id,
      target: r.to_placement_id,
      sourceHandle: 'output',
      targetHandle: 'input',
      selectable: false,
      deletable: false,
      markerEnd: { type: MarkerType.ArrowClosed, color: '#5a6b8c', width: 18, height: 18 },
      data: { label: r.label, onRemove },
    }));
}

// Where a drawn arrow waits for its word: the cards it joins and the drop point.
export interface ArrowDraft {
  from: string;
  to: string;
  x: number;
  y: number;
}
// Names a drawn arrow. One press picks an offered word; another word can be typed.
// Escape or a press elsewhere leaves the arrow undrawn.
export function RelationPicker({
  draft,
  onPick,
  onClose,
}: {
  draft: ArrowDraft;
  onPick: (label: string) => void;
  onClose: () => void;
}) {
  const [word, setWord] = useState('');
  const box = useRef<HTMLFormElement>(null);
  useEffect(() => {
    box.current?.querySelector('button')?.focus({ preventScroll: true });
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as globalThis.Node)) onClose();
    };
    globalThis.document.addEventListener('pointerdown', away, true);
    return () => globalThis.document.removeEventListener('pointerdown', away, true);
  }, [onClose]);
  return (
    <form
      ref={box}
      className="relation-picker"
      data-canvas-native
      role="dialog"
      aria-label="Name the arrow"
      style={{ left: draft.x, top: draft.y }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (word.trim()) onPick(word.trim());
      }}
    >
      {RELATION_LABELS.map((label) => (
        <button key={label} type="button" onClick={() => onPick(label)}>
          {label}
        </button>
      ))}
      <input
        aria-label="Another word"
        placeholder="another word"
        maxLength={MAX_RELATION_LABEL}
        value={word}
        onChange={(event) => setWord(event.target.value)}
      />
    </form>
  );
}
