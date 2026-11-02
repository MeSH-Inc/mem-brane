import { memo, useMemo } from 'react';
import { useStore } from 'zustand';
import type { WorkspaceDocument } from '../services/workspace-document';
import { useInteraction } from '../stores/interaction';
import { statusLabels } from '../lib/labels';
import { formatUsd } from '../lib/format';
import { chainReceipt, machinePresses, type Press } from './machines';

const ACTIVE = new Set(['queued', 'claimed', 'running', 'cancel_requested']);
const modelName = (model: string) => (model === 'mock' ? 'Local mock' : model);
const pressTime = (time: number) =>
  new Date(time).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

// The back of a machine: which version of the prompt it is at, what its past presses
// ran and cost, and the models its next press compares.
export const MachineBack = memo(function MachineBack({
  placementId,
  blockId,
  document,
  models,
  onKeepCurrent,
  children,
}: {
  onKeepCurrent: (placementId: string, keptCurrent: boolean) => void;
  // The lever, pressed from the back once the models are chosen.
  children?: React.ReactNode;
  placementId: string;
  blockId: string;
  document: WorkspaceDocument;
  // The models a comparison may choose from.
  models: string[];
}) {
  const version = useStore(document.store, (s) => s.blocks[blockId]?.version ?? 0);
  // The prompt version the newest press ran, if it has run.
  const pressedVersion = useStore(document.store, (s) => {
    const runIds = new Set(
      (s.state?.derivations ?? [])
        .filter((d) => d.anchorPlacementId === placementId)
        .map((d) => d.runId),
    );
    return (s.state?.runs ?? []).filter((r) => runIds.has(r.id)).at(-1)?.machine_version ?? null;
  });
  const pressKey = useStore(document.store, (s) =>
    JSON.stringify(s.state ? machinePresses(s.state, placementId) : []),
  );
  // The chain behind the newest answer, when another machine's answer was among its inputs.
  const chainKey = useStore(document.store, (s) =>
    JSON.stringify(s.state ? chainReceipt(s.state, placementId) : []),
  );
  const chain = useMemo(() => JSON.parse(chainKey) as ReturnType<typeof chainReceipt>, [chainKey]);
  const keptCurrent = useStore(document.store, (s) => !!s.state?.keptCurrent.includes(placementId));
  const presses = useMemo(() => JSON.parse(pressKey) as Press[], [pressKey]);
  const compared = useInteraction((s) => s.comparisons[placementId]);
  const chosen = (compared ?? []).filter((model) => models.includes(model));
  return (
    <div className="card-back machine-back nodrag nopan">
      <p className="back-receipt">
        <span className="eyebrow">Prompt</span> version {version}
        {pressedVersion !== null && pressedVersion !== version && (
          <span className="back-meta"> · the last press ran version {pressedVersion}</span>
        )}
      </p>
      {models.length > 1 && (
        <fieldset className="machine-compare">
          <legend>Compare models on the next press</legend>
          {models.map((model) => (
            <label key={model}>
              <input
                type="checkbox"
                checked={chosen.includes(model)}
                onChange={(event) =>
                  useInteraction
                    .getState()
                    .compare(
                      placementId,
                      event.target.checked ? [...chosen, model] : chosen.filter((m) => m !== model),
                    )
                }
              />
              {modelName(model)}
            </label>
          ))}
        </fieldset>
      )}
      {children}
      <label className="back-receipt machine-keep">
        <input
          type="checkbox"
          checked={keptCurrent}
          onChange={(event) => onKeepCurrent(placementId, event.target.checked)}
        />
        Keep current
        <span className="back-meta">
          {' '}
          · marked due when a machine feeding it reruns; nothing runs without a press
        </span>
      </label>
      {chain.length > 1 && (
        <section className="back-receipt" aria-label="Chain">
          <span className="eyebrow">Chain behind the newest answer</span>
          <ol className="machine-presses">
            {chain.map(({ placementId: machine, name, press }) => (
              <li key={machine}>
                <PressLine press={press} label={name} />
              </li>
            ))}
            <li className="chain-total">
              <span>Total</span>
              <span />
              <span>{chain.reduce((sum, link) => sum + link.press.runs, 0)} runs</span>
              <span>{costOf(chain.map((link) => link.press))}</span>
            </li>
          </ol>
        </section>
      )}
      <section className="back-receipt" aria-label="Presses">
        <span className="eyebrow">Presses</span>
        {presses.length ? (
          <ol className="machine-presses">
            {presses.map((press) => (
              <li key={press.id}>
                <PressLine press={press} label={pressTime(press.created_at)} />
              </li>
            ))}
          </ol>
        ) : (
          <p className="back-meta">Not run yet.</p>
        )}
      </section>
    </div>
  );
});

const costOf = (presses: Press[]) =>
  presses.every((press) => press.confirmed_microusd !== null)
    ? formatUsd(presses.reduce((sum, press) => sum + press.confirmed_microusd!, 0))
    : presses.some((press) => press.statuses.some(([status]) => ACTIVE.has(status)))
      ? 'cost pending'
      : 'cost not known';
// One press: its label, models, runs and how they ended, and its cost.
function PressLine({ press, label }: { press: Press; label: string }) {
  return (
    <>
      <span>{label}</span>
      <span>{press.models.map(modelName).join(' · ')}</span>
      <span>
        {press.runs} {press.runs === 1 ? 'run' : 'runs'},{' '}
        {press.statuses
          .map(([status, count]) =>
            press.statuses.length > 1
              ? `${count} ${statusLabels[status] ?? status}`
              : (statusLabels[status] ?? status),
          )
          .join(', ')}
      </span>
      <span>{costOf([press])}</span>
    </>
  );
}
