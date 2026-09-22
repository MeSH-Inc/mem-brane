import type { WorkspaceController } from '../services/workspace';
import { CommandButton } from './CommandButton';

const active = new Set(['queued', 'claimed', 'running', 'cancel_requested']);
export function RunActivity({
  controller,
  onOpen,
}: {
  controller: WorkspaceController;
  onOpen: (id: string) => void;
}) {
  const runs =
    controller.state?.runs.filter(
      (run) =>
        active.has(run.status) || ['failed', 'interrupted', 'cancelled'].includes(run.status),
    ) ?? [];
  if (!runs.length) return null;
  return (
    <details className="run-activity">
      <summary>
        {runs.filter((run) => active.has(run.status)).length > 0
          ? `${runs.filter((run) => active.has(run.status)).length} generating`
          : 'Generation needs attention'}
        {runs.some((run) => !active.has(run.status)) && ' · Review results'}
      </summary>
      <div className="activity-list">
        {runs.map((run) => (
          <div key={run.id} className="activity-item">
            <span role="status">
              {run.status === 'cancel_requested' ? 'Stopping…' : run.status}
            </span>
            <button onClick={() => onOpen(run.output_block_id)}>Open</button>
            {active.has(run.status) ? (
              <CommandButton
                tasks={controller.commands}
                taskKey={`cancel:${run.id}`}
                pendingLabel="Stopping…"
                disabled={run.status === 'cancel_requested'}
                onClick={() => void controller.cancelRun(run.id).catch(() => {})}
              >
                Stop
              </CommandButton>
            ) : (
              <CommandButton
                tasks={controller.commands}
                taskKey={`retry:${run.id}`}
                pendingLabel="Retrying…"
                onClick={() => void controller.retryRun(run.id).catch(() => {})}
              >
                Retry with the same inputs
              </CommandButton>
            )}
            {run.error && <p className="error">{run.error}</p>}
          </div>
        ))}
      </div>
    </details>
  );
}
