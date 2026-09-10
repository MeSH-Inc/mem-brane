import { replica } from '../services/api';
import { useEffect, useState, useSyncExternalStore } from 'react';

export function AppStatus() {
  const sync = useSyncExternalStore(replica.subscribe, replica.getSnapshot);
  const [review, setReview] = useState<Awaited<ReturnType<typeof replica.inspectConflict>>>();
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(navigator.onLine);
  const [update, setUpdate] = useState(false);
  const [problem, setProblem] = useState('');
  useEffect(() => replica.start(), []);
  useEffect(() => {
    const online = () => setConnected(true);
    const offline = () => setConnected(false);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    let disposed = false;
    if (import.meta.env.PROD && 'serviceWorker' in navigator) {
      void navigator.serviceWorker
        .register('/sw.js', { updateViaCache: 'none' })
        .then((registration) => {
          const check = () => {
            if (!disposed) setUpdate(!!registration.waiting);
          };
          check();
          registration.addEventListener('updatefound', () => {
            registration.installing?.addEventListener('statechange', check);
          });
        })
        .catch(() => {
          if (!disposed)
            setProblem('Offline app installation failed. Reconnect and reload to retry.');
        });
    }
    return () => {
      disposed = true;
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, []);
  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    setProblem('');
    try {
      await work();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const disconnected = !connected || !sync.connected;
  if (!disconnected && !update && !problem && !sync.pending && !sync.error) return null;
  return (
    <aside className="app-status" aria-label="App connection and updates">
      {!connected && <p>Disconnected. Reconnect to synchronize your workspace and use AI.</p>}
      {!!sync.pending && (
        <p>
          {sync.pending} local {sync.pending === 1 ? 'change' : 'changes'} waiting to synchronize.
          Saved on this device.
        </p>
      )}
      {sync.error && <p>{sync.error}</p>}
      {sync.conflict && (
        <div className="sync-conflict">
          <p>
            <strong>Synchronization paused for this item:</strong> {sync.conflict.failure?.message}
          </p>
          <p>Other items continue synchronizing.</p>
          <button
            disabled={busy}
            onClick={() => void act(async () => setReview(await replica.inspectConflict()))}
          >
            Review conflict
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const blob = new Blob([JSON.stringify(await replica.exportLocal(), null, 2)], {
                  type: 'application/json',
                });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'mem-brane-local-recovery.json';
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              })
            }
          >
            Export local recovery
          </button>
          {review?.key === sync.conflict.key && (
            <>
              <div className="conflict-comparison">
                <div>
                  <strong>Local change</strong>
                  <pre>{describeChange(review.local)}</pre>
                </div>
                <div>
                  <strong>Current server state</strong>
                  <pre>{describeChange(review.server)}</pre>
                </div>
              </div>
              {['text.edit', 'placement.edit', 'placement.remove', 'brane.title'].includes(
                sync.conflict.command.type,
              ) && (
                <>
                  <p>
                    Your choice applies to all queued changes to this same item. Other local changes
                    are retained.
                  </p>
                  <button
                    disabled={busy}
                    onClick={() => void act(() => replica.resolveConflict('local'))}
                  >
                    Keep local changes
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => void act(() => replica.resolveConflict('server'))}
                  >
                    Use server changes
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}
      {(disconnected || !!sync.pending || !!sync.error) && (
        <button disabled={busy} onClick={() => void act(() => replica.retry())}>
          Retry synchronization
        </button>
      )}
      {problem && <p>{problem}</p>}
      {update && (
        <p>An app update is ready. Close all mem-brane windows and reopen to install it.</p>
      )}
    </aside>
  );
}

function describeChange(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return 'Unavailable';
  if ('content' in value) return describeChange(value.content);
  if ('text' in value && typeof value.text === 'string') return value.text || '(Empty text)';
  if ('title' in value && typeof value.title === 'string') return value.title;
  if ('type' in value && value.type === 'placement.remove') return 'Remove this placement';
  if ('x' in value && 'y' in value && 'width' in value && 'height' in value)
    return `Position: ${value.x}, ${value.y}\nSize: ${value.width} × ${value.height}`;
  return 'Review this item in the workspace before retrying.';
}
