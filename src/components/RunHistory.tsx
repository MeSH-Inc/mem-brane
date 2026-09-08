import { useEffect, useRef, useState } from 'react';
import type { RunPage } from '../../shared/types/history';
import { api } from '../services/api';

// Mount with the brane ID as its key. History is fetched only when explicitly opened.
export function RunHistory({
  braneId,
  onInspect,
}: {
  braneId: string;
  onInspect: (id: string) => Promise<void>;
}) {
  const [page, setPage] = useState<RunPage>({ items: [], nextCursor: null });
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  async function load(cursor?: string) {
    const generation = ++request.current;
    setLoading(true);
    setError('');
    try {
      const next = await api<RunPage>(
        `/branes/${braneId}/runs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      if (generation !== request.current) return;
      setPage((previous) => ({
        items: cursor ? [...previous.items, ...next.items] : next.items,
        nextCursor: next.nextCursor,
      }));
      setLoaded(true);
    } catch (error) {
      if (generation === request.current) setError((error as Error).message);
    } finally {
      if (generation === request.current) setLoading(false);
    }
  }
  return (
    <details
      onToggle={(event) => {
        if (event.currentTarget.open && !loaded && !loading) void load();
      }}
    >
      <summary>Run history</summary>
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">Loading run history…</p>}
      <button disabled={loading} onClick={() => void load()}>
        Refresh history
      </button>
      {loaded && !page.items.length && <p>No runs yet.</p>}
      <ol>
        {page.items.map((run) => (
          <li key={run.id}>
            <button
              onClick={() => void onInspect(run.id).catch((error) => setError(error.message))}
            >
              {new Date(run.created_at).toLocaleString()} · {run.model} · {run.status}
            </button>
          </li>
        ))}
      </ol>
      {page.nextCursor && (
        <button disabled={loading} onClick={() => void load(page.nextCursor!)}>
          Load older runs
        </button>
      )}
    </details>
  );
}
