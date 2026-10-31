import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { WorkspaceDocument } from '../services/workspace-document';
import type { Estimate } from '../../shared/contracts';
import { machineSlots } from '../../shared/machines';
import { machineOutput } from '../../shared/machine-output';
import { useInteraction } from '../stores/interaction';
import { formatUsd } from '../lib/format';
import { machineStaleness, type MachineView } from './machines';

export interface MachineActions {
  onRunMachine: (placementId: string) => Promise<unknown>;
  onEstimateMachine: (placementId: string) => Promise<Estimate>;
  onFeed: (fromPlacementIds: string[], toPlacementId: string, slot: string) => Promise<unknown>;
  // The machine's tray feeds another machine's slot.
  onFeedTray: (machinePlacementId: string, toPlacementId: string, slot: string) => Promise<unknown>;
  onUnfeed: (feedId: string) => Promise<unknown>;
  onFeedMode: (feedId: string, mode: 'together' | 'each') => Promise<unknown>;
  onSaveToWorkshop: (blockId: string) => void;
  onDuplicate: (placementId: string) => void;
  // The models a comparison may choose from.
  models: string[];
}

export function useMachineView(document: WorkspaceDocument, placementId: string, draft?: string) {
  // A string selector keeps the machine still while unrelated cards stream or move.
  const viewKey = useStore(document.store, (s) =>
    s.state ? JSON.stringify(machineStaleness(s.state, placementId, draft)) : '',
  );
  return useMemo(() => (viewKey ? (JSON.parse(viewKey) as MachineView) : undefined), [viewKey]);
}

// The slot rows and the lever. The canvas draws a feed handle on each slot; Focus,
// which has no canvas, shows the same rows and lever without them.
export function MachineControls({
  placementId,
  blockId,
  document,
  actions,
  handle,
  comparing = false,
  onCloseCompare,
}: {
  placementId: string;
  blockId: string;
  document: WorkspaceDocument;
  actions: MachineActions;
  handle?: (slot: string) => React.ReactNode;
  // The model picker for the next press is open.
  comparing?: boolean;
  onCloseCompare?: () => void;
}) {
  const compared = useInteraction((s) => s.comparisons[placementId]);
  const models = useMemo(
    () => (compared ?? []).filter((model) => actions.models.includes(model)),
    [compared, actions.models],
  );
  const block = useStore(document.store, (s) => s.blocks[blockId]);
  const draft = useInteraction((s) => s.drafts[blockId]);
  const selection = useInteraction((s) => s.selectedPlacements);
  const view = useMachineView(document, placementId, draft);
  const viewKey = JSON.stringify(view ?? null);
  // A card feed is named by its card's first words, a group feed by the group.
  const previews = useStore(document.store, (s) =>
    JSON.stringify(
      Object.fromEntries(
        (view?.feeds ?? []).map((feed) => {
          const group = feed.groupId && s.scene.groups.find((g) => g.id === feed.groupId);
          const input = view?.inputs.find((i) => i.feedId === feed.feedId);
          return [
            feed.feedId,
            group
              ? `${group.label} · ${feed.count}`
              : (s.blocks[input?.blockId ?? '']?.content.text ?? '').trim().slice(0, 28) ||
                'Untitled card',
          ];
        }),
      ),
    ),
  );
  const labels = useMemo(() => JSON.parse(previews) as Record<string, string>, [previews]);
  const template = draft ?? block?.content.text ?? '';
  const slots = machineSlots(template);
  const output = machineOutput(template);
  const [running, setRunning] = useState(false);
  const [estimate, setEstimate] = useState<Estimate | 'unavailable'>();
  const estimateFor = useRef('');
  const ready =
    !!view && slots.length > 0 && slots.every((slot) => view.inputs.some((i) => i.slot === slot));
  // Re-estimate when what the lever would send changes; stale answers are discarded.
  useEffect(() => {
    if (!ready) return;
    const key = `${viewKey}|${template}|${models.join(',')}`;
    estimateFor.current = key;
    const timer = setTimeout(() => {
      actions
        .onEstimateMachine(placementId)
        .then((next) => estimateFor.current === key && setEstimate(next))
        .catch(() => estimateFor.current === key && setEstimate('unavailable'));
    }, 400);
    return () => clearTimeout(timer);
  }, [ready, viewKey, template, models, placementId, actions]);
  const candidates = selection.filter((id) => id !== placementId);
  const missing = slots.find((slot) => !view?.inputs.some((i) => i.slot === slot));
  const refused = estimate && estimate !== 'unavailable' && !estimate.canAfford;
  const lever = running
    ? 'Running…'
    : !slots.length
      ? 'Name a {slot} in the prompt'
      : missing
        ? `Feed ${missing}`
        : view?.eachConflict
          ? 'One slot runs each'
          : models.length > 1 && view?.eachSlot
            ? 'Compare with the cards together'
            : refused
              ? 'Over today’s allowance'
              : `${view?.stale ? 'Rerun' : 'Run'}${
                  models.length > 1
                    ? ` ×${models.length} models`
                    : view && view.runs > 1
                      ? ` ×${view.runs}`
                      : ''
                }${
                  estimate && estimate !== 'unavailable' && estimate.reservedMicrousd > 0
                    ? ` · ${formatUsd(estimate.reservedMicrousd)}`
                    : ''
                }`;
  return (
    <>
      <ul className="machine-slots" aria-label="Slots">
        {slots.map((slot) => {
          const fed = view?.feeds.filter((f) => f.slot === slot) ?? [];
          return (
            <li
              key={slot}
              className={`machine-slot${view?.inputs.some((i) => i.slot === slot) ? '' : ' empty'}`}
              data-feed-slot={slot}
              data-feed-machine={placementId}
            >
              {handle?.(slot)}
              <span className="slot-name">{slot}</span>
              <span className="slot-feeds nodrag nopan">
                {fed.map((feed) => (
                  <span
                    key={feed.feedId}
                    className={`slot-chip${feed.groupId ? ' group' : ''}${view?.changedFeeds.includes(feed.feedId) && view.ran ? ' changed' : ''}`}
                  >
                    <span className="slot-chip-label">{labels[feed.feedId]}</span>
                    {feed.groupId && (
                      <button
                        className={`slot-mode${feed.mode === 'each' ? ' each' : ''}`}
                        aria-pressed={feed.mode === 'each'}
                        aria-label={`Run ${labels[feed.feedId]} one card at a time`}
                        title={
                          feed.mode === 'each'
                            ? 'Each: one run per card. Press to send them together in one run.'
                            : 'Together: one run with every card. Press to run once per card.'
                        }
                        onClick={() =>
                          void actions.onFeedMode(
                            feed.feedId,
                            feed.mode === 'each' ? 'together' : 'each',
                          )
                        }
                      >
                        {feed.mode === 'each' ? 'each' : 'together'}
                      </button>
                    )}
                    <button
                      aria-label={`Remove ${labels[feed.feedId]} from ${slot}`}
                      onClick={() => void actions.onUnfeed(feed.feedId)}
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
      {(comparing || models.length > 0) && (
        <fieldset className="machine-compare nodrag nopan">
          <legend>Compare models on the next press</legend>
          {actions.models.map((model) => (
            <label key={model}>
              <input
                type="checkbox"
                checked={models.includes(model)}
                onChange={(event) =>
                  useInteraction
                    .getState()
                    .compare(
                      placementId,
                      event.target.checked ? [...models, model] : models.filter((m) => m !== model),
                    )
                }
              />
              {model === 'mock' ? 'Local mock' : model}
            </label>
          ))}
          <button
            className="text-button"
            onClick={() => {
              useInteraction.getState().compare(placementId, []);
              onCloseCompare?.();
            }}
          >
            Done
          </button>
        </fieldset>
      )}
      <footer className="machine-footer nodrag nopan">
        {output !== 'card' && (
          <span className="machine-output" title="What one answer becomes on the table">
            → {output}
          </span>
        )}
        <button
          className={`machine-lever${view?.stale ? ' stale' : ''}`}
          disabled={
            running ||
            !ready ||
            !!refused ||
            !!view?.eachConflict ||
            (models.length > 1 && !!view?.eachSlot)
          }
          onClick={() => {
            // A comparison is chosen for one press; the picker closes with it.
            if (models.length > 1) onCloseCompare?.();
            setRunning(true);
            void actions.onRunMachine(placementId).finally(() => setRunning(false));
          }}
        >
          {lever}
        </button>
      </footer>
    </>
  );
}
