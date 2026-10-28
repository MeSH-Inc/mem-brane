import { replica } from '../services/api';
import { useEffect, useState, useSyncExternalStore } from 'react';

export function AppStatus() {
  const sync = useSyncExternalStore(replica.subscribe, replica.getSnapshot);
  const [review, setReview] = useState<Awaited<ReturnType<typeof replica.inspectConflict>>>();
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(navigator.onLine);
  const [update, setUpdate] = useState(false);
  const [problem, setProblem] = useState('');
  const [live, setLive] = useState(true);
  useEffect(() => {
    const change = (event: Event) => setLive((event as CustomEvent<boolean>).detail);
    window.addEventListener('brane:live', change);
    return () => window.removeEventListener('brane:live', change);
  }, []);
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
  const paused = !disconnected && !live;
  if (!disconnected && !paused && !update && !problem && !sync.error && !sync.conflicts.length)
    return null;
  return (
    <aside className="app-status" aria-label="App connection and updates">
      {!connected && <p>Disconnected. Reconnect to synchronize your workspace and use AI.</p>}
      {paused && <p>Live updates paused. Reconnecting; responses still finish on the server.</p>}
      {!!sync.pending && (
        <p>
          {sync.pending} local {sync.pending === 1 ? 'change' : 'changes'} waiting to synchronize.
          Saved on this device.
        </p>
      )}
      {sync.error && <p>{sync.error}</p>}
      {!!sync.conflicts.length && (
        <div className="sync-conflict">
          <p>
            <strong>
              Synchronization paused for {sync.conflicts.length}{' '}
              {sync.conflicts.length === 1 ? 'item' : 'items'}.
            </strong>{' '}
            Other items continue synchronizing.
          </p>
          {sync.conflicts.map((conflict) => {
            const creation = creationTypes.includes(conflict.command.type);
            return (
              <div key={conflict.key} className="sync-conflict-item">
                <p>{conflict.failure?.message}</p>
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(async () => setReview(await replica.inspectConflict(conflict.key)))
                  }
                >
                  Review
                </button>
                <button disabled={busy} onClick={() => void act(() => replica.retry(conflict.key))}>
                  Retry
                </button>
                {review?.key === conflict.key && (
                  <>
                    <div className="conflict-comparison">
                      <div>
                        <strong>On this device</strong>
                        <pre>{describeChange(review.local)}</pre>
                      </div>
                      <div>
                        <strong>Current server state</strong>
                        <pre>{describeChange(review.server)}</pre>
                      </div>
                    </div>
                    {creation ? (
                      <>
                        <p>
                          Discarding removes this new item and the queued changes that depend on it.
                          Other local changes are retained.
                        </p>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act(() => replica.resolveConflict(conflict.key, 'server'))
                          }
                        >
                          Discard this item
                        </button>
                      </>
                    ) : (
                      <>
                        <p>
                          Your choice applies to all queued changes to this same item. Choosing the
                          server keeps your text as a separate copy.
                        </p>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act(() => replica.resolveConflict(conflict.key, 'local'))
                          }
                        >
                          Keep local changes
                        </button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act(() => replica.resolveConflict(conflict.key, 'server'))
                          }
                        >
                          Use server changes
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
            );
          })}
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
        </div>
      )}
      {(disconnected || !!sync.error) && (
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

const creationTypes = ['text.create', 'placement.create', 'brane.create'];

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
