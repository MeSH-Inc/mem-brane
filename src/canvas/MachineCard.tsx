import { memo, useEffect, useRef, useState } from 'react';
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react';
import { useStore } from 'zustand';
import type { WorkspaceDocument } from '../services/workspace-document';
import { machineSlots } from '../../shared/machines';
import { BlockContent } from '../components/BlockContent';
import { ActionMenu } from '../components/ActionMenu';
import { useInteraction } from '../stores/interaction';
import { MachineControls, useMachineView, type MachineActions } from './MachineControls';
export type { MachineActions } from './MachineControls';

export const slotHandle = (slot: string) => `slot:${slot}`;

// A machine is a prompt with named slots. Each slot row is a feed target; the lever
// runs it once with exactly the cards fed now. Nothing here runs by itself.
export const MachineCard = memo(function MachineCard({
  placementId,
  blockId,
  document,
  selected,
  focusRequest,
  onFocused,
  onEdit,
  actions,
  onManage,
  children,
}: {
  children?: React.ReactNode;
  onManage?: (view: 'versions' | 'remove') => void;
  placementId: string;
  blockId: string;
  document: WorkspaceDocument;
  selected: boolean;
  focusRequest?: string;
  onFocused?: (id: string) => void;
  onEdit: (id: string, text: string) => void;
  actions: MachineActions;
}) {
  const block = useStore(document.store, (s) => s.blocks[blockId]);
  const draft = useInteraction((s) => s.drafts[blockId]);
  const view = useMachineView(document, placementId, draft);
  // Slot handles appear and vanish with the template; React Flow must re-measure them
  // or feeds into a new slot have no anchor to draw to.
  const updateNodeInternals = useUpdateNodeInternals();
  const slotKey = machineSlots(draft ?? block?.content.text ?? '').join('\u0000');
  useEffect(() => updateNodeInternals(placementId), [slotKey, placementId, updateNodeInternals]);
  if (!block) return null;
  const state = view?.stale ? 'stale' : view?.ran ? 'ran' : '';
  return (
    <article
      className={`canvas-card machine-card ${selected ? 'selected' : ''} ${view?.stale ? 'stale' : ''}`}
    >
      <Handle type="source" position={Position.Right} id="output" isConnectable={false} />
      {children}
      <header className="card-grip">
        <span className="kind-mark">⚙</span>
        <span>Machine</span>
        <span className="card-status">
          {state && (
            <span className={`machine-state ${state}`}>
              {view?.stale
                ? view.templateChanged
                  ? 'stale · prompt edited'
                  : view.changedSlots.length
                    ? `stale · ${view.changedSlots.join(', ')} changed`
                    : 'stale · arrows changed'
                : 'ran'}
            </span>
          )}
        </span>
        {onManage && (
          <ActionMenu
            label="Machine actions"
            text="⋯"
            align="right"
            className="card-menu nodrag nopan"
          >
            <button onClick={() => actions.onSaveToWorkshop(blockId)}>Save to Workshop</button>
            <button onClick={() => onManage('versions')}>Version history</button>
            <button onClick={() => onManage('remove')}>Remove from this brane</button>
          </ActionMenu>
        )}
      </header>
      <div className="machine-prompt">
        <BlockContent
          block={block}
          onEdit={onEdit}
          focusRequest={focusRequest}
          onFocused={onFocused}
        />
      </div>
      <MachineControls
        placementId={placementId}
        blockId={blockId}
        document={document}
        actions={actions}
        handle={(slot) => (
          <Handle
            type="target"
            position={Position.Left}
            id={slotHandle(slot)}
            isConnectable={false}
            className="slot-handle"
          />
        )}
      />
    </article>
  );
});

// Drag from a card's port onto a machine's slot row to feed it, or onto another card
// to draw an arrow to it; a group's port feeds only. The port is a native surface, so
// the canvas gesture recognizer never sees this drag.
export function CardPort({
  owner,
  title = 'Drag onto a machine slot to feed it, or onto a card to draw an arrow',
  onFeed,
  onArrow,
}: {
  // The node the port belongs to; a drop on that node does nothing.
  owner: string;
  title?: string;
  onFeed: (toPlacementId: string, slot: string) => void;
  onArrow?: (toPlacementId: string, point: { x: number; y: number }) => void;
}) {
  const [line, setLine] = useState<{ x1: number; y1: number; x2: number; y2: number }>();
  // The drag's start is read from a ref: a quick drag can end before React has drawn
  // the line its start set.
  const start = useRef<{ x1: number; y1: number }>(undefined);
  return (
    <>
      <span
        className="card-port"
        data-canvas-native
        title={title}
        onPointerDown={(event) => {
          event.stopPropagation();
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          const bounds = event.currentTarget.getBoundingClientRect();
          const x1 = bounds.left + bounds.width / 2,
            y1 = bounds.top + bounds.height / 2;
          start.current = { x1, y1 };
          setLine({ x1, y1, x2: event.clientX, y2: event.clientY });
        }}
        onPointerMove={(event) =>
          start.current && setLine({ ...start.current, x2: event.clientX, y2: event.clientY })
        }
        onPointerUp={(event) => {
          if (!start.current) return;
          start.current = undefined;
          setLine(undefined);
          const under = globalThis.document.elementFromPoint(event.clientX, event.clientY);
          const slot = under?.closest<HTMLElement>('[data-feed-slot]');
          if (slot?.dataset.feedMachine && slot.dataset.feedSlot) {
            onFeed(slot.dataset.feedMachine, slot.dataset.feedSlot);
            return;
          }
          const card = under?.closest<HTMLElement>('.react-flow__node-card')?.dataset.id;
          if (card && card !== owner) onArrow?.(card, { x: event.clientX, y: event.clientY });
        }}
        onPointerCancel={() => {
          start.current = undefined;
          setLine(undefined);
        }}
      />
      {line && (
        <svg className="port-draft" aria-hidden="true">
          <line {...line} />
        </svg>
      )}
    </>
  );
}
