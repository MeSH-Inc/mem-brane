import { useEffect, useRef, useState } from 'react';
import type { Block, Brane, Placement, Revision, Geometry } from '../../shared/types/domain';
import type { RevisionPage } from '../../shared/types/history';
import { api } from '../services/api';
export function ArtifactActions({
  block,
  placements,
  onChange,
  onSave,
  onGeometry,
  onClose,
}: {
  block: Block;
  placements: Placement[];
  onChange: () => Promise<void>;
  onSave: () => Promise<unknown>;
  onGeometry: (id: string, geometry: Geometry) => Promise<void>;
  onClose: () => void;
}) {
  const [branes, setBranes] = useState<Brane[]>([]),
    [target, setTarget] = useState(''),
    [history, setHistory] = useState<Revision[]>([]),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const historyRequest = useRef(0);
  const activeBlock = useRef(block.id);
  activeBlock.current = block.id;
  const load = async (cursor?: string) => {
    if (block.id !== activeBlock.current) return;
    const request = ++historyRequest.current;
    setLoading(true);
    try {
      const page = await api<RevisionPage>(
        `/blocks/${block.id}/revisions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      if (request !== historyRequest.current) return;
      setHistory((previous) => (cursor ? [...previous, ...page.items] : page.items));
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (request === historyRequest.current) throw error;
    } finally {
      if (request === historyRequest.current) setLoading(false);
    }
  };
  useEffect(() => {
    setHistory([]);
    setNextCursor(null);
    void api<Brane[]>('/branes')
      .then(setBranes)
      .catch((e) => setError(e.message));
    void load().catch((e) => setError(e.message));
    return () => {
      historyRequest.current++;
    };
  }, [block.id]);
  async function action(work: () => Promise<unknown>, message: string) {
    try {
      setError('');
      await work();
      await onChange();
      setNotice(message);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <section className="artifact-actions" aria-label="Block actions">
      <header>
        <strong>{block.kind} · block actions</strong>
        <button onClick={onClose} aria-label="Close block actions">
          ×
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="artifact-row">
        <button
          onClick={() =>
            void action(async () => {
              await onSave();
              await api(`/blocks/${block.id}/snapshot`, {});
              await load();
            }, 'Snapshot saved')
          }
        >
          Save snapshot
        </button>
        <select
          aria-label="Destination brane"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          <option value="">Choose a brane…</option>
          {branes.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title}
            </option>
          ))}
        </select>
        <button
          disabled={!target}
          onClick={() =>
            void action(
              () =>
                api('/placements', {
                  braneId: target,
                  blockId: block.id,
                  geometry: { x: 140, y: 140, width: 320, height: 240 },
                }),
              'Same block placed in the chosen brane',
            )
          }
        >
          Place in brane
        </button>
      </div>
      <details>
        <summary>Placements in this brane ({placements.length})</summary>
        {placements.map((p, i) => (
          <div className="artifact-row" key={p.id}>
            <span>Placement {i + 1}</span>
            <GeometryForm
              placement={p}
              onApply={(g) => void action(() => onGeometry(p.id, g), 'Placement geometry saved')}
            />
            <button
              onClick={() =>
                void action(async () => {
                  await onSave();
                  await api(`/placements/${p.id}`, undefined, 'DELETE');
                }, 'Placement removed; the block and its history are retained')
              }
            >
              Remove placement {i + 1}
            </button>
          </div>
        ))}
      </details>
      <details>
        <summary>
          Saved snapshots ({history.length}
          {nextCursor ? '+' : ''})
        </summary>
        {history.map((r) => (
          <details key={r.id}>
            <summary>{new Date(r.created_at).toLocaleString()}</summary>
            <code>{r.id}</code>
            <pre>{r.content.text}</pre>
            {r.content.assetId && (
              <img
                className="context-image"
                src={`/api/assets/${r.content.assetId}`}
                alt="Frozen image snapshot"
              />
            )}
          </details>
        ))}
        {nextCursor && (
          <button
            disabled={loading}
            onClick={() => void load(nextCursor).catch((e) => setError(e.message))}
          >
            Load older snapshots
          </button>
        )}
        {loading && <p role="status">Loading snapshots…</p>}
      </details>
    </section>
  );
}

function GeometryForm({
  placement,
  onApply,
}: {
  placement: Placement;
  onApply: (geometry: { x: number; y: number; width: number; height: number }) => void;
}) {
  return (
    <form
      className="geometry-form"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        onApply({
          x: Number(data.get('x')),
          y: Number(data.get('y')),
          width: Number(data.get('width')),
          height: Number(data.get('height')),
        });
      }}
    >
      {(['x', 'y', 'width', 'height'] as const).map((field) => (
        <label key={field}>
          {field}
          <input
            type="number"
            step="any"
            required
            name={field}
            defaultValue={placement[field]}
            min={field === 'width' ? 180 : field === 'height' ? 120 : -1000000}
            max={field === 'width' || field === 'height' ? 4000 : 1000000}
          />
        </label>
      ))}
      <button>Apply geometry</button>
    </form>
  );
}
