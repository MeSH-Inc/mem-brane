import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { UnplacedPage } from '../../shared/contracts';
import type { Block } from '../../shared/types/domain';
import { cardKind } from '../lib/labels';
import { client } from '../services/client';
import { replica } from '../services/api';
import type { CommandTasks } from '../services/command-tasks';
import { CommandButton } from './CommandButton';
import { Dialog } from './Dialog';
import { LocalImage } from './LocalAsset';
import { PdfContent } from './PdfContent';

export function UnplacedCards({
  commands,
  onShowHere,
  onOpen,
  onClose,
}: {
  commands: CommandTasks;
  onShowHere: (blockId: string) => Promise<void>;
  onOpen: (blockId: string) => void;
  onClose: () => void;
}) {
  const sync = useSyncExternalStore(replica.subscribe, replica.getSnapshot);
  const [page, setPage] = useState<UnplacedPage>({ items: [], nextCursor: null });
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string>();
  const [selected, setSelected] = useState<Block>();
  const [previewError, setPreviewError] = useState('');
  const [restoreError, setRestoreError] = useState<{ id: string; message: string }>();
  const listRequest = useRef(0);
  const failedCursor = useRef<string | undefined>(undefined);
  const previewRequest = useRef(0);
  const mounted = useRef(false);
  async function load(cursor?: string) {
    const request = ++listRequest.current;
    setLoading(true);
    setError('');
    try {
      if (replica.getSnapshot().pending) await replica.synchronize();
      if (request !== listRequest.current) return;
      if (replica.getSnapshot().pending)
        throw new Error('Finish syncing or resolve local changes, then refresh these cards.');
      const next = await client.unplacedCards(cursor);
      if (request !== listRequest.current) return;
      setPage((previous) => ({
        items: cursor ? [...previous.items, ...next.items] : next.items,
        nextCursor: next.nextCursor,
      }));
      setLoaded(true);
    } catch (error) {
      if (request === listRequest.current) {
        failedCursor.current = cursor;
        setError((error as Error).message);
      }
    } finally {
      if (request === listRequest.current) setLoading(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      listRequest.current++;
      previewRequest.current++;
    };
  }, []);
  async function inspect(id: string, retry = false) {
    const request = ++previewRequest.current;
    setSelected(undefined);
    setPreviewError('');
    if (selectedId === id && !retry) {
      setSelectedId(undefined);
      return;
    }
    setSelectedId(id);
    try {
      const block = await client.block(id);
      if (request === previewRequest.current) setSelected(block);
    } catch (error) {
      if (request === previewRequest.current) setPreviewError((error as Error).message);
    }
  }
  async function restore(id: string) {
    setRestoreError(undefined);
    try {
      await onShowHere(id);
      if (mounted.current) onOpen(id);
    } catch (error) {
      if (mounted.current) setRestoreError({ id, message: (error as Error).message });
    }
  }
  return (
    <Dialog title="Unplaced cards" onClose={onClose}>
      <section className="unplaced-cards">
        <p>Cards in this library that are no longer shown on any brane.</p>
        <button disabled={loading} onClick={() => void load()}>
          Refresh cards
        </button>
        {!sync.connected && (
          <p role="status">
            Offline. Saved results may be out of date. Reconnect and refresh to find recently
            removed cards.
          </p>
        )}
        {error && (
          <div>
            <p role="alert">{error}</p>
            <button disabled={loading} onClick={() => void load(failedCursor.current)}>
              Retry loading cards
            </button>
          </div>
        )}
        {loaded && !page.items.length && sync.connected && !sync.pending && (
          <p>No unplaced cards.</p>
        )}
        <ol className="unplaced-list">
          {page.items.map((card) => (
            <li key={card.id} className="unplaced-card">
              <strong>{cardKind(card)}</strong>
              <small>{new Date(card.created_at).toLocaleString()}</small>
              <p>{card.preview || 'Empty card'}</p>
              <div className="artifact-row">
                <button
                  aria-expanded={selectedId === card.id}
                  onClick={() => void inspect(card.id)}
                >
                  {selectedId === card.id ? 'Close preview' : 'Preview'}
                </button>
                <CommandButton
                  tasks={commands}
                  taskKey={`restore:${card.id}`}
                  pendingLabel="Showing…"
                  onClick={() => void restore(card.id)}
                >
                  Show here
                </CommandButton>
              </div>
              {restoreError?.id === card.id && <p role="alert">{restoreError.message}</p>}
              {selectedId === card.id && (
                <section className="card-preview" aria-label="Card preview">
                  {previewError ? (
                    <>
                      <p role="alert">{previewError}</p>
                      <button onClick={() => void inspect(card.id, true)}>Retry preview</button>
                    </>
                  ) : !selected ? (
                    <p role="status">Loading card…</p>
                  ) : (
                    <>
                      {selected.content.format === 'pdf' ? (
                        <PdfContent content={selected.content} showProvenance />
                      ) : (
                        <pre>{selected.content.text || 'No text on this card.'}</pre>
                      )}
                      {selected.content.format === 'image' && (
                        <LocalImage
                          className="context-image"
                          assetId={selected.content.assetId}
                          alt={selected.content.filename}
                        />
                      )}
                    </>
                  )}
                </section>
              )}
            </li>
          ))}
        </ol>
        {page.nextCursor && (
          <button disabled={loading} onClick={() => void load(page.nextCursor!)}>
            Load more cards
          </button>
        )}
        {loading && <p role="status">Loading cards…</p>}
      </section>
    </Dialog>
  );
}
