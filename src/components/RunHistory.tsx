import { useEffect, useRef, useState } from 'react';
import type { RunPage } from '../../shared/types/history';
import { client } from '../services/client';

// Earlier responses whose cards are no longer on this brane. Mount with the brane ID
// as its key; the server history is fetched only when explicitly requested.
export function RunHistory({
  braneId,
  exclude,
  onInspect,
}: {
  braneId: string;
  exclude: string[];
  onInspect: (id: string) => void;
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
      const next = await client.runPage(braneId, cursor);
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
  const shown = new Set(exclude);
  const earlier = page.items.filter((run) => !shown.has(run.id));
  return (
    <section className="earlier-runs" aria-label="Earlier responses">
      {error && <p role="alert">{error}</p>}
      {!loaded && (
        <button disabled={loading} onClick={() => void load()}>
          Show earlier responses
        </button>
      )}
      {loading && <p role="status">Loading earlier responses…</p>}
      {loaded && !earlier.length && !page.nextCursor && <p>No earlier responses.</p>}
      <ol>
        {earlier.map((run) => (
          <li key={run.id}>
            <button onClick={() => onInspect(run.id)}>
              {new Date(run.created_at).toLocaleString()} · {run.model} · {run.status}
            </button>
          </li>
        ))}
      </ol>
      {page.nextCursor && (
        <button disabled={loading} onClick={() => void load(page.nextCursor!)}>
          Load more
        </button>
      )}
    </section>
  );
}
