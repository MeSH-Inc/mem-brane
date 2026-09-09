import { PdfContent } from './PdfContent';
import { useEffect, useRef, useState } from 'react';
import type { Block, Brane, Placement, Revision, Geometry } from '../../shared/types/domain';
import type { RevisionSummary } from '../../shared/types/history';
import { client } from '../services/client';
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
    [history, setHistory] = useState<RevisionSummary[]>([]),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [selected, setSelected] = useState<Revision>();
  const [revisionError, setRevisionError] = useState('');
  const revisionRequest = useRef(0);
  const inspect = async (id: string) => {
    const request = ++revisionRequest.current;
    setSelected(undefined);
    setRevisionError('');
    if (selectedId === id && !revisionError) {
      setSelectedId(undefined);
      return;
    }
    setSelectedId(id);
    try {
      const revision = await client.revision(id);
      if (request === revisionRequest.current) setSelected(revision);
    } catch (error) {
      if (request === revisionRequest.current) setRevisionError((error as Error).message);
    }
  };
  const historyRequest = useRef(0);
  const activeBlock = useRef(block.id);
  activeBlock.current = block.id;
  const load = async (cursor?: string) => {
    if (block.id !== activeBlock.current) return;
    const request = ++historyRequest.current;
    setLoading(true);
    try {
      const page = await client.revisionPage(block.id, cursor);
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
    setSelectedId(undefined);
    setSelected(undefined);
    setRevisionError('');
    setNextCursor(null);
    void client
      .branes()
      .then(setBranes)
      .catch((e) => setError(e.message));
    void load().catch((e) => setError(e.message));
    return () => {
      historyRequest.current++;
      revisionRequest.current++;
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
              await client.snapshot(block.id);
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
                client.createPlacement(target, block.id, {
                  x: 140,
                  y: 140,
                  width: 320,
                  height: 240,
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
                  await client.removePlacement(p.id);
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
          <div key={r.id}>
            <button
              type="button"
              aria-expanded={selectedId === r.id}
              onClick={() => void inspect(r.id)}
            >
              {new Date(r.created_at).toLocaleString()} · {r.preview || r.format}
            </button>
            {selectedId === r.id && (
              <div>
                <code>{r.id}</code>
                {revisionError ? (
                  <>
                    <p role="alert">{revisionError}</p>
                    <button onClick={() => void inspect(r.id)}>Retry snapshot</button>
                  </>
                ) : !selected ? (
                  <p role="status">Loading snapshot…</p>
                ) : (
                  <>
                    <pre>{selected.content.text}</pre>
                    {selected.content.format === 'pdf' && (
                      <PdfContent content={selected.content} showProvenance />
                    )}
                    {selected.content.format === 'image' && (
                      <img
                        className="context-image"
                        src={`/api/assets/${selected.content.assetId}`}
                        alt="Frozen image snapshot"
                      />
                    )}
                  </>
                )}
              </div>
            )}
          </div>
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
