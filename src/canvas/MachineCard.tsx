import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react';
import { useStore } from 'zustand';
import type { WorkspaceDocument } from '../services/workspace-document';
import type { Estimate } from '../../shared/contracts';
import { machineSlots } from '../../shared/machines';
import { BlockContent } from '../components/BlockContent';
import { useInteraction } from '../stores/interaction';
import { formatUsd } from '../lib/format';
import { machineStaleness, type MachineView } from './machines';

export interface MachineActions {
  onRunMachine: (placementId: string) => Promise<unknown>;
  onEstimateMachine: (placementId: string) => Promise<Estimate>;
  onFeed: (fromPlacementIds: string[], toPlacementId: string, slot: string) => Promise<unknown>;
  onUnfeed: (feedId: string) => Promise<unknown>;
}

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
  children,
}: {
  children?: React.ReactNode;
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
  const selection = useInteraction((s) => s.selectedPlacements);
  // A string selector keeps this card still while unrelated cards stream or move.
  const viewKey = useStore(document.store, (s) =>
    s.state ? JSON.stringify(machineStaleness(s.state, placementId, draft)) : '',
  );
  const view: MachineView | undefined = useMemo(
    () => (viewKey ? (JSON.parse(viewKey) as MachineView) : undefined),
    [viewKey],
  );
  const previews = useStore(document.store, (s) =>
    JSON.stringify(
      Object.fromEntries(
        (view?.inputs ?? []).map((input) => [
          input.feedId,
          (s.blocks[input.blockId]?.content.text ?? '').trim().slice(0, 28) || 'Untitled card',
        ]),
      ),
    ),
  );
  const labels = useMemo(() => JSON.parse(previews) as Record<string, string>, [previews]);
  const template = draft ?? block?.content.text ?? '';
  const slots = machineSlots(template);
  // Slot handles appear and vanish with the template; React Flow must re-measure them
  // or feeds into a new slot have no anchor to draw to.
  const updateNodeInternals = useUpdateNodeInternals();
  const slotKey = slots.join('\u0000');
  useEffect(() => updateNodeInternals(placementId), [slotKey, placementId, updateNodeInternals]);
  const [running, setRunning] = useState(false);
  const [estimate, setEstimate] = useState<Estimate | 'unavailable'>();
  const estimateFor = useRef('');
  const ready =
    !!view && slots.length > 0 && slots.every((slot) => view.inputs.some((i) => i.slot === slot));
  // Re-estimate when what the lever would send changes; stale answers are discarded.
  useEffect(() => {
    if (!ready) return;
    const key = `${viewKey}|${template}`;
    estimateFor.current = key;
    const timer = setTimeout(() => {
      actions
        .onEstimateMachine(placementId)
        .then((next) => estimateFor.current === key && setEstimate(next))
        .catch(() => estimateFor.current === key && setEstimate('unavailable'));
    }, 400);
    return () => clearTimeout(timer);
  }, [ready, viewKey, template, placementId, actions]);
  if (!block) return null;
  const candidates = selection.filter((id) => id !== placementId);
  const missing = slots.find((slot) => !view?.inputs.some((i) => i.slot === slot));
  const refused = estimate && estimate !== 'unavailable' && !estimate.canAfford;
  const lever = running
    ? 'Running…'
    : !slots.length
      ? 'Name a {slot} in the prompt'
      : missing
        ? `Feed ${missing}`
        : refused
          ? 'Over today’s allowance'
          : `${view?.stale ? 'Rerun' : 'Run'}${
              estimate && estimate !== 'unavailable' && estimate.reservedMicrousd > 0
                ? ` · ${formatUsd(estimate.reservedMicrousd)}`
                : ''
            }`;
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
                  : `stale · ${view.changedSlots.join(', ')} changed`
                : 'ran'}
            </span>
          )}
        </span>
      </header>
      <div className="machine-prompt">
        <BlockContent
          block={block}
          onEdit={onEdit}
          focusRequest={focusRequest}
          onFocused={onFocused}
        />
      </div>
      <ul className="machine-slots" aria-label="Slots">
        {slots.map((slot) => {
          const fed = view?.inputs.filter((i) => i.slot === slot) ?? [];
          return (
            <li
              key={slot}
              className={`machine-slot${fed.length ? '' : ' empty'}`}
              data-feed-slot={slot}
              data-feed-machine={placementId}
            >
              <Handle
                type="target"
                position={Position.Left}
                id={slotHandle(slot)}
                isConnectable={false}
                className="slot-handle"
              />
              <span className="slot-name">{slot}</span>
              <span className="slot-feeds nodrag nopan">
                {fed.map((input) => (
                  <span
                    key={input.feedId}
                    className={`slot-chip${view?.changedFeeds.includes(input.feedId) && view.ran ? ' changed' : ''}`}
                  >
                    <span className="slot-chip-label">{labels[input.feedId]}</span>
                    <button
                      aria-label={`Remove ${labels[input.feedId]} from ${slot}`}
                      onClick={() => void actions.onUnfeed(input.feedId)}
                    >
                      ×
                    </button>
                  </span>
                ))}
                {candidates.length > 0 && (
                  <button
                    className="slot-add"
                    onClick={() => void actions.onFeed(candidates, placementId, slot)}
                  >
                    + {candidates.length} selected
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <footer className="nodrag nopan">
        <button
          className={`machine-lever${view?.stale ? ' stale' : ''}`}
          disabled={running || !ready || !!refused}
          onClick={() => {
            setRunning(true);
            void actions.onRunMachine(placementId).finally(() => setRunning(false));
          }}
        >
          {lever}
        </button>
      </footer>
    </article>
  );
});

// Drag from a card's feed port onto a machine's slot row to feed it. The port is a
// native surface, so the canvas gesture recognizer never sees this drag.
export function FeedPort({
  placementId,
  onFeed,
}: {
  placementId: string;
  onFeed: MachineActions['onFeed'];
}) {
  const [line, setLine] = useState<{ x1: number; y1: number; x2: number; y2: number }>();
  return (
    <>
      <span
        className="feed-port"
        data-canvas-native
        title="Drag onto a machine slot to feed it"
        onPointerDown={(event) => {
          event.stopPropagation();
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          const bounds = event.currentTarget.getBoundingClientRect();
          const x1 = bounds.left + bounds.width / 2,
            y1 = bounds.top + bounds.height / 2;
          setLine({ x1, y1, x2: event.clientX, y2: event.clientY });
        }}
        onPointerMove={(event) =>
          line && setLine({ ...line, x2: event.clientX, y2: event.clientY })
        }
        onPointerUp={(event) => {
          if (!line) return;
          setLine(undefined);
          const target = globalThis.document
            .elementFromPoint(event.clientX, event.clientY)
            ?.closest<HTMLElement>('[data-feed-slot]');
          if (target?.dataset.feedMachine && target.dataset.feedSlot)
            void onFeed([placementId], target.dataset.feedMachine, target.dataset.feedSlot);
        }}
        onPointerCancel={() => setLine(undefined)}
      />
      {line && (
        <svg className="feed-draft" aria-hidden="true">
          <line {...line} />
        </svg>
      )}
    </>
  );
}
