import { memo, useMemo } from 'react';
import { useStore } from 'zustand';
import type { WorkspaceDocument } from '../services/workspace-document';
import { useInteraction } from '../stores/interaction';
import { statusLabels } from '../lib/labels';
import { formatUsd } from '../lib/format';

// One press of the lever: the runs it admitted, together, each, or one per compared model.
export interface Press {
  id: string;
  created_at: number;
  models: string[];
  runs: number;
  // Each status among the press's runs, with how many runs have it.
  statuses: [string, number][];
  // The press's cost, once every run's usage is settled.
  confirmed_microusd: number | null;
}

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
  children,
}: {
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
  const pressKey = useStore(document.store, (s) => {
    const scene = s.state;
    if (!scene) return '[]';
    const runIds = new Set(
      scene.derivations.filter((d) => d.anchorPlacementId === placementId).map((d) => d.runId),
    );
    const presses = new Map<string, Press>();
    for (const run of scene.runs) {
      if (!runIds.has(run.id)) continue;
      const id = run.batch_id ?? run.id;
      const press = presses.get(id) ?? {
        id,
        created_at: run.created_at,
        models: [],
        runs: 0,
        statuses: [],
        confirmed_microusd: 0,
      };
      press.created_at = Math.min(press.created_at, run.created_at);
      if (!press.models.includes(run.model)) press.models.push(run.model);
      press.runs += 1;
      const status = press.statuses.find(([name]) => name === run.status);
      if (status) status[1] += 1;
      else press.statuses.push([run.status, 1]);
      press.confirmed_microusd =
        press.confirmed_microusd === null || run.confirmed_microusd === null
          ? null
          : press.confirmed_microusd + run.confirmed_microusd;
      presses.set(id, press);
    }
    return JSON.stringify([...presses.values()].sort((a, b) => b.created_at - a.created_at));
  });
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
      <section className="back-receipt" aria-label="Presses">
        <span className="eyebrow">Presses</span>
        {presses.length ? (
          <ol className="machine-presses">
            {presses.map((press) => (
              <li key={press.id}>
                <span>{pressTime(press.created_at)}</span>
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
                <span>
                  {press.confirmed_microusd !== null
                    ? formatUsd(press.confirmed_microusd)
                    : press.statuses.some(([status]) => ACTIVE.has(status))
                      ? 'cost pending'
                      : 'cost not known'}
                </span>
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
