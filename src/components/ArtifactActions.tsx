import { Dialog } from './Dialog';
import { CommandButton } from './CommandButton';
import type { CommandTasks } from '../services/command-tasks';
import { LocalImage } from './LocalAsset';
import { PdfContent } from './PdfContent';
import { useEffect, useRef, useState } from 'react';
import type { Block, Brane, Revision } from '../../shared/types/domain';
import type { RevisionSummary } from '../../shared/types/history';
import { client } from '../services/client';
import { needsAccount } from '../services/api';
export type CardAction = 'place' | 'remove' | 'versions';
const titles: Record<CardAction, string> = {
  place: 'Show on another brane',
  remove: 'Remove from this brane',
  versions: 'Version history',
};
// Card-level operations, each reached directly from a card's menu.
export function ArtifactActions({
  view,
  commands,
  block,
  placementId,
  braneId,
  onChange,
  onSave,
  onClose,
}: {
  view: CardAction;
  commands: CommandTasks;
  block: Block;
  placementId?: string;
  braneId: string;
  onChange: () => Promise<void>;
  onSave: () => Promise<unknown>;
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
    activeBlock.current = block.id;
    setHistory([]);
    setSelectedId(undefined);
    setSelected(undefined);
    setRevisionError('');
    setNextCursor(null);
    if (view === 'place')
      void client
        .branes()
        .then((list) => setBranes(list.filter((b) => b.id !== braneId)))
        .catch((e) => setError(e.message));
    if (view === 'versions') void load().catch((e) => setError(e.message));
    return () => {
      activeBlock.current = '';
      historyRequest.current++;
      revisionRequest.current++;
    };
  }, [block.id, view]);
  async function action(key: string, work: () => Promise<unknown>, message: string) {
    try {
      await commands.run(key, async (progress) => {
        setError('');
        await work();
        progress('refreshing');
        await onChange();
        if (activeBlock.current === block.id) setNotice(message);
      });
    } catch (e) {
      if (activeBlock.current === block.id) setError((e as Error).message);
    }
  }
  return (
    <Dialog title={titles[view]} onClose={onClose}>
      <section className="artifact-actions" aria-label={titles[view]}>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {view === 'place' && (
          <>
            <p>The same card appears in both branes, and edits show in each.</p>
            <div className="artifact-row">
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
              <CommandButton
                tasks={commands}
                taskKey={`place:${block.id}:${target}`}
                pendingLabel="Adding…"
                disabled={!target}
                onClick={() =>
                  void action(
                    `place:${block.id}:${target}`,
                    () =>
                      client.createPlacement(target, block.id, {
                        x: 140,
                        y: 140,
                        width: 320,
                        height: 240,
                      }),
                    `Now also on ${branes.find((b) => b.id === target)?.title ?? 'that brane'}`,
                  )
                }
              >
                Show there
              </CommandButton>
            </div>
          </>
        )}
        {view === 'remove' && (
          <>
            <p>The card leaves this brane. Other branes that show it, and its history, keep it.</p>
            <div className="artifact-row">
              <CommandButton
                tasks={commands}
                taskKey={`remove:${placementId}`}
                pendingLabel="Removing…"
                disabled={!placementId}
                onClick={async () => {
                  try {
                    await commands.run(`remove:${placementId}`, async () => {
                      await client.removePlacement(placementId!);
                      await onChange();
                    });
                    onClose();
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Remove
              </CommandButton>
              <button onClick={onClose}>Keep it</button>
            </div>
          </>
        )}
        {view === 'versions' && (
          <>
            <div className="artifact-row">
              <CommandButton
                tasks={commands}
                taskKey={`snapshot:${block.id}`}
                pendingLabel="Saving version…"
                onClick={() =>
                  !needsAccount() &&
                  void action(
                    `snapshot:${block.id}`,
                    async () => {
                      await onSave();
                      await client.snapshot(block.id);
                      await load();
                    },
                    'Version saved',
                  )
                }
              >
                Save a version now
              </CommandButton>
            </div>
            {!loading && !history.length && <p>No saved versions yet.</p>}
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
                        <button onClick={() => void inspect(r.id)}>Retry version</button>
                      </>
                    ) : !selected ? (
                      <p role="status">Loading version…</p>
                    ) : (
                      <>
                        <pre>{selected.content.text}</pre>
                        {selected.content.format === 'pdf' && (
                          <PdfContent content={selected.content} showProvenance />
                        )}
                        {selected.content.format === 'image' && (
                          <LocalImage
                            className="context-image"
                            assetId={selected.content.assetId!}
                            alt="Saved image version"
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
                Load older versions
              </button>
            )}
            {loading && <p role="status">Loading versions…</p>}
          </>
        )}
      </section>
    </Dialog>
  );
}
