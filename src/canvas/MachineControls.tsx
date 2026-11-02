import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { WorkspaceDocument } from '../services/workspace-document';
import type { Estimate } from '../../shared/contracts';
import { feedClosesLoop, machineName, machineSlots } from '../../shared/machines';
import { machineOutput } from '../../shared/machine-output';
import { useInteraction } from '../stores/interaction';
import { ActionMenu } from '../components/ActionMenu';
import { formatUsd } from '../lib/format';
import {
  machineChain,
  machineStaleness,
  machineTray,
  type MachineChain,
  type MachineView,
} from './machines';

export interface MachineActions {
  onRunMachine: (placementId: string) => Promise<unknown>;
  // Rerun the stale machines upstream, then this one, one after another.
  onRunChain: (placementId: string) => Promise<unknown>;
  onEstimateMachine: (placementId: string) => Promise<Estimate>;
  onFeed: (fromPlacementIds: string[], toPlacementId: string, slot: string) => Promise<unknown>;
  // The machine's tray feeds another machine's slot.
  onFeedTray: (machinePlacementId: string, toPlacementId: string, slot: string) => Promise<unknown>;
  onUnfeed: (feedId: string) => Promise<unknown>;
  onFeedMode: (feedId: string, mode: 'together' | 'each') => Promise<unknown>;
  onSaveToWorkshop: (blockId: string) => void;
  onDuplicate: (placementId: string) => void;
  onKeepCurrent: (placementId: string, keptCurrent: boolean) => void;
  // The models a comparison may choose from.
  models: string[];
}

export function useMachineChain(document: WorkspaceDocument, placementId: string) {
  const chainKey = useStore(document.store, (s) =>
    s.state ? JSON.stringify(machineChain(s.state, placementId)) : '',
  );
  return useMemo(() => (chainKey ? (JSON.parse(chainKey) as MachineChain) : undefined), [chainKey]);
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
  slots: showSlots = true,
}: {
  placementId: string;
  blockId: string;
  document: WorkspaceDocument;
  actions: MachineActions;
  handle?: (slot: string) => React.ReactNode;
  // The slot rows show; the back of a machine shows the lever alone.
  slots?: boolean;
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
  const chain = useMachineChain(document, placementId);
  const chained = chain && chain.chain.length > 1 ? chain.chain : null;
  const waitingOnRun = !!chain?.waitingOn?.running;
  const viewKey = JSON.stringify(view ?? null);
  // The machines whose tray could feed each slot: run, not this machine, not feeding the
  // slot already, and not fed by this machine however far down.
  const sourcesKey = useStore(document.store, (s) => {
    const state = s.state;
    if (!state) return '{}';
    const machines = state.placements.filter(
      (p) =>
        p.id !== placementId &&
        !p.host_placement_id &&
        state.blocks.find((b) => b.id === p.block_id)?.kind === 'machine',
    );
    return JSON.stringify(
      Object.fromEntries(
        machineSlots(s.blocks[blockId]?.content.text ?? '').map((slot) => [
          slot,
          machines.flatMap((machine) => {
            const tray = machineTray(state, machine.id);
            if (!tray) return [];
            const fed = state.feeds.some(
              (f) =>
                f.to_placement_id === placementId &&
                f.slot === slot &&
                ('groupId' in tray
                  ? f.from_group_id === tray.groupId
                  : f.from_placement_id === tray.placementId),
            );
            if (fed || feedClosesLoop(state, tray, placementId)) return [];
            const template = state.blocks.find((b) => b.id === machine.block_id)?.content.text;
            return [{ placementId: machine.id, name: machineName(template ?? '') }];
          }),
        ]),
      ),
    );
  });
  // The slots of other machines this machine's tray could feed: the mirror of the
  // sources above, so a chain can be built from either end, or on a phone.
  const targetsKey = useStore(document.store, (s) => {
    const state = s.state;
    const tray = state && machineTray(state, placementId);
    if (!state || !tray) return '[]';
    return JSON.stringify(
      state.placements
        .filter(
          (p) =>
            p.id !== placementId &&
            !p.host_placement_id &&
            state.blocks.find((b) => b.id === p.block_id)?.kind === 'machine',
        )
        .flatMap((machine) => {
          if (feedClosesLoop(state, tray, machine.id)) return [];
          const template = state.blocks.find((b) => b.id === machine.block_id)?.content.text ?? '';
          return machineSlots(template).flatMap((slot) =>
            state.feeds.some(
              (f) =>
                f.to_placement_id === machine.id &&
                f.slot === slot &&
                ('groupId' in tray
                  ? f.from_group_id === tray.groupId
                  : f.from_placement_id === tray.placementId),
            )
              ? []
              : [{ placementId: machine.id, slot, name: `${machineName(template)} · ${slot}` }],
          );
        }),
    );
  });
  const targets = useMemo(
    () => JSON.parse(targetsKey) as { placementId: string; slot: string; name: string }[],
    [targetsKey],
  );
  const sources = useMemo(
    () => JSON.parse(sourcesKey) as Record<string, { placementId: string; name: string }[]>,
    [sourcesKey],
  );
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
    // An answer still being written upstream cannot be estimated from; the lever waits.
    if (!ready || waitingOnRun) return;
    const key = `${viewKey}|${template}|${models.join(',')}|${chained?.join(',')}`;
    estimateFor.current = key;
    // A chain's estimate is the sum of each machine's own, over what it is fed now.
    const timer = setTimeout(() => {
      Promise.all((chained ?? [placementId]).map((id) => actions.onEstimateMachine(id)))
        .then((each) => {
          if (estimateFor.current !== key) return;
          const reservedMicrousd = each.reduce((sum, next) => sum + next.reservedMicrousd, 0);
          const last = each.at(-1)!;
          setEstimate({
            ...last,
            reservedMicrousd,
            canAfford: reservedMicrousd <= last.budget.availableMicrousd,
          });
        })
        .catch(() => estimateFor.current === key && setEstimate('unavailable'));
    }, 400);
    return () => clearTimeout(timer);
  }, [ready, waitingOnRun, viewKey, template, models, placementId, actions, chained]);
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
            : chain?.waitingOn?.running
              ? `Waiting on ${chain.waitingOn.name}`
              : refused
                ? 'Over today’s allowance'
                : chained
                  ? `Rerun the chain ×${chained.length}${
                      estimate && estimate !== 'unavailable' && estimate.reservedMicrousd > 0
                        ? ` · ${formatUsd(estimate.reservedMicrousd)}`
                        : ''
                    }`
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
      {showSlots && (
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
                  {sources[slot]?.length > 0 && (
                    <ActionMenu
                      label={`Feed ${slot} from another machine`}
                      text="Feed from…"
                      className="slot-source"
                    >
                      {sources[slot].map((source) => (
                        <button
                          key={source.placementId}
                          onClick={() =>
                            void actions.onFeedTray(source.placementId, placementId, slot)
                          }
                        >
                          {source.name}
                        </button>
                      ))}
                    </ActionMenu>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <footer className="machine-footer nodrag nopan">
        {targets.length > 0 && (
          <ActionMenu
            label="Feed this machine’s answers into another machine"
            text="Feed into…"
            className="machine-targets"
          >
            {targets.map((target) => (
              <button
                key={`${target.placementId}:${target.slot}`}
                onClick={() =>
                  void actions.onFeedTray(placementId, target.placementId, target.slot)
                }
              >
                {target.name}
              </button>
            ))}
          </ActionMenu>
        )}
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
            (models.length > 1 && !!view?.eachSlot) ||
            !!chain?.waitingOn?.running
          }
          onClick={() => {
            setRunning(true);
            void (chained ? actions.onRunChain : actions.onRunMachine)(placementId).finally(() =>
              setRunning(false),
            );
          }}
        >
          {lever}
        </button>
        {chain?.waitingOn && ready && !running && (
          <button
            className="text-button machine-only"
            title={`Run this machine on what it is fed now, without waiting for ${chain.waitingOn.name}`}
            onClick={() => {
              setRunning(true);
              void actions.onRunMachine(placementId).finally(() => setRunning(false));
            }}
          >
            Run this one only
          </button>
        )}
      </footer>
    </>
  );
}
