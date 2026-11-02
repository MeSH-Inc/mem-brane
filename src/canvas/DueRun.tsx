import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { WorkspaceDocument } from '../services/workspace-document';
import type { Estimate } from '../../shared/contracts';
import { formatUsd } from '../lib/format';
import { dueMachines } from '../../shared/machine-staleness';

// The brane's machines kept current that are due, and one press that runs them with
// every machine their chains need, in feeding order. Shown only when one is due.
export function DueRun({
  document,
  onEstimate,
  onRun,
}: {
  document: WorkspaceDocument;
  onEstimate: (placementId: string) => Promise<Estimate>;
  onRun: () => Promise<unknown>;
}) {
  const dueKey = useStore(document.store, (s) =>
    JSON.stringify(s.state ? dueMachines(s.state) : { due: [], run: [], waitingOn: null }),
  );
  const due = useMemo(() => JSON.parse(dueKey) as ReturnType<typeof dueMachines>, [dueKey]);
  const [estimate, setEstimate] = useState<{ microusd: number; canAfford: boolean }>();
  const [running, setRunning] = useState(false);
  const estimateFor = useRef('');
  useEffect(() => {
    setEstimate(undefined);
    if (!due.run.length || due.waitingOn) return;
    estimateFor.current = dueKey;
    const timer = setTimeout(() => {
      Promise.all(due.run.map((id) => onEstimate(id)))
        .then((each) => {
          if (estimateFor.current !== dueKey) return;
          const microusd = each.reduce((sum, next) => sum + next.reservedMicrousd, 0);
          setEstimate({ microusd, canAfford: microusd <= each[0].budget.availableMicrousd });
        })
        .catch(() => undefined);
    }, 400);
    return () => clearTimeout(timer);
  }, [due, dueKey, onEstimate]);
  if (!due.due.length) return null;
  const refused = estimate && !estimate.canAfford;
  return (
    <button
      className="due-run"
      disabled={running || !!due.waitingOn || !!refused}
      title={`${due.due.length} ${due.due.length === 1 ? 'machine kept current is' : 'machines kept current are'} due; one press runs ${due.run.length} ${due.run.length === 1 ? 'machine' : 'machines'} in feeding order`}
      onClick={() => {
        setRunning(true);
        void onRun().finally(() => setRunning(false));
      }}
    >
      {running
        ? 'Running due…'
        : due.waitingOn
          ? `${due.due.length} due · waiting on ${due.waitingOn.name}`
          : refused
            ? `${due.due.length} due · over today’s allowance`
            : `Run all due ×${due.run.length}${estimate && estimate.microusd > 0 ? ` · ${formatUsd(estimate.microusd)}` : ''}`}
    </button>
  );
}
