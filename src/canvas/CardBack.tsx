import { memo, useEffect, useMemo, useState } from 'react';
import { client } from '../services/client';
import { useStore } from 'zustand';
import type { WorkspaceDocument } from '../services/workspace-document';
import { LiveBlockContent } from '../components/LiveBlockContent';
import { ResponseSources } from '../components/ResponseSources';
import type { ResponseActions } from '../components/ResponseContent';
import { statusLabels } from '../lib/labels';
import { answerStaleness } from './machines';
import type { Block } from '../../shared/types/domain';

// A card named by its first words, for lists that point at other cards.
export const cardName = (block: Block | undefined) =>
  (block?.content.text ?? '').trim().slice(0, 32) || 'Untitled card';

export interface BackActions extends ResponseActions {
  onDetach: (placementId: string) => void;
  // Turn an asked answer back into a machine fed with the same cards.
  onReuse: (runId: string, question: string) => void;
  // Ask an answer's question again over its current sources, in its place.
  onUpdate: (runId: string, placementId: string) => Promise<unknown>;
  onOpenSource: (blockId: string) => void;
  onInspect: (runId: string) => void;
  onRerun: (runId: string) => void;
}

const noEdit = () => {};

// The back of a card: how it came to be, and what came of it. A generated card shows
// its receipt; every card lists the outputs held on its back, newest first: the
// developments of it and, for a machine's output, the earlier versions it replaced.
export const CardBack = memo(function CardBack({
  placementId,
  blockId,
  document,
  actions,
}: {
  placementId: string;
  blockId: string;
  document: WorkspaceDocument;
  actions: BackActions;
}) {
  const generated = useStore(document.store, (s) => s.blocks[blockId]?.origin === 'generated');
  const receipt = useStore(document.store, (s) => {
    const run = s.runs[blockId];
    return run
      ? `${new Date(run.created_at).toLocaleString()} · ${run.model === 'mock' ? 'Local mock' : run.model} · ${statusLabels[run.status] ?? run.status}`
      : '';
  });
  // A primitive key keeps the back still while unrelated cards stream or move.
  const heldKey = useStore(document.store, (s) =>
    JSON.stringify(backItems(s.scene.placements, s.runs, s.scene.derivations, placementId)),
  );
  const held = useMemo(() => JSON.parse(heldKey) as BackItem[], [heldKey]);
  // An answer composed from a prompt (not a machine's, not a development) shows the
  // question it answers, read from the run's frozen prompt entry.
  const askedRun = useStore(document.store, (s) => {
    const run = s.runs[blockId];
    return run &&
      !run.machine_block_id &&
      !s.scene.derivations.some((d) => d.outputBlockId === blockId && d.kind === 'source')
      ? run.id
      : '';
  });
  // A source edited, or an arrow between sources drawn, reworded or removed, since the
  // answer was asked offers Update.
  const stale = useStore(
    document.store,
    (s) => !!s.state && answerStaleness(s.state, blockId).stale,
  );
  // The arrows this answer's run sent, as sentences over its sources' first words.
  const sentKey = useStore(document.store, (s) => {
    const run = s.runs[blockId];
    if (!run || !s.state) return '[]';
    return JSON.stringify(
      s.state.relationEntries
        .filter((e) => e.runId === run.id)
        .map((e) => [cardName(s.blocks[e.fromBlockId]), e.label, cardName(s.blocks[e.toBlockId])]),
    );
  });
  const sent = useMemo(() => JSON.parse(sentKey) as [string, string, string][], [sentKey]);
  const [updating, setUpdating] = useState(false);
  const [question, setQuestion] = useState('');
  // Based on lists the sources with Exact inputs; a run without sources still has them.
  const unsourced = useStore(document.store, (s) =>
    s.runs[blockId] && !s.scene.derivations.some((d) => d.outputBlockId === blockId)
      ? s.runs[blockId].id
      : '',
  );
  useEffect(() => {
    if (!askedRun) return;
    let current = true;
    client
      .run(askedRun)
      .then((detail) => {
        const prompt = detail.inputs.find((input) => input.kind === 'prompt');
        if (current) setQuestion(prompt?.content.text ?? '');
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [askedRun]);
  return (
    <div className="card-back nodrag nopan" aria-label="Card back">
      {generated && (
        <section className="back-receipt" aria-label="Receipt">
          <span className="eyebrow">Receipt</span>
          {receipt && <p className="back-meta">{receipt}</p>}
          {question && (
            <blockquote className="back-question" aria-label="Question">
              {question}
              {stale && (
                <button
                  className="text-button update-button"
                  title="Ask this again over the current sources; this answer goes on the new one’s back"
                  disabled={updating}
                  onClick={() => {
                    setUpdating(true);
                    void actions.onUpdate(askedRun, placementId).finally(() => setUpdating(false));
                  }}
                >
                  Update
                </button>
              )}
              <button
                className="text-button"
                title="A machine with this question as its prompt, fed with the same cards"
                onClick={() => actions.onReuse(askedRun, question)}
              >
                Make reusable
              </button>
            </blockquote>
          )}
          {sent.length > 0 && (
            <ul className="back-arrows" aria-label="Arrows sent">
              {sent.map(([from, label, to], index) => (
                <li key={index}>
                  {from} <strong>{label}</strong> {to}
                </li>
              ))}
            </ul>
          )}
          {unsourced && (
            <button className="text-button" onClick={() => actions.onInspect(unsourced)}>
              Exact inputs
            </button>
          )}
          <ResponseSources
            document={document}
            blockId={blockId}
            onOpenSource={actions.onOpenSource}
            onInspect={actions.onInspect}
            onRerun={actions.onRerun}
          />
        </section>
      )}
      {held.length > 0 ? (
        <ol className="back-items" aria-label="On the back">
          {held.map((item) => (
            <li key={item.placementId} className="back-item">
              <header>
                <span className="eyebrow" title={new Date(item.createdAt).toLocaleString()}>
                  {item.earlier ? 'Earlier version' : 'Development'}
                </span>
                {item.runId && (
                  <button className="text-button" onClick={() => actions.onInspect(item.runId!)}>
                    Exact inputs
                  </button>
                )}
                <button className="text-button" onClick={() => actions.onDetach(item.placementId)}>
                  Put on table
                </button>
              </header>
              <LiveBlockContent
                document={document}
                blockId={item.blockId}
                onEdit={noEdit}
                onStop={actions.onStop}
                onRetry={actions.onRetry}
              />
            </li>
          ))}
        </ol>
      ) : (
        !generated && (
          <p className="back-empty">Nothing developed yet. Develop writes its result here.</p>
        )
      )}
    </div>
  );
});

interface BackItem {
  placementId: string;
  blockId: string;
  runId?: string;
  createdAt: number;
  earlier: boolean;
}
// A development is a developed output; every other generated card on a back is an
// earlier version that a rerun or an Update replaced.
export function backItems(
  placements: { id: string; block_id: string; host_placement_id: string | null }[],
  runs: Record<string, { id: string; created_at: number }>,
  derivations: { outputBlockId: string; kind: string }[],
  hostPlacementId: string,
): BackItem[] {
  return placements
    .filter((p) => p.host_placement_id === hostPlacementId)
    .map((p) => {
      const run = runs[p.block_id];
      return {
        placementId: p.id,
        blockId: p.block_id,
        runId: run?.id,
        createdAt: run?.created_at ?? 0,
        earlier:
          !!run && !derivations.some((d) => d.outputBlockId === p.block_id && d.kind === 'source'),
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

// A card's arrows, listed: where arrows are not drawn (Focus and phones), this is how
// they are read and removed.
export function CardArrows({
  placementId,
  document,
  onRemove,
}: {
  placementId: string;
  document: WorkspaceDocument;
  onRemove: (relationId: string) => void;
}) {
  const key = useStore(document.store, (s) => {
    const block = new Map(s.scene.placements.map((p) => [p.id, p.block_id]));
    return JSON.stringify(
      s.scene.relations
        .filter((r) => r.from_placement_id === placementId || r.to_placement_id === placementId)
        .map((r) => ({
          id: r.id,
          label: r.label,
          outgoing: r.from_placement_id === placementId,
          other: cardName(
            s.blocks[
              block.get(
                r.from_placement_id === placementId ? r.to_placement_id : r.from_placement_id,
              )!
            ],
          ),
        })),
    );
  });
  const arrows = useMemo(
    () => JSON.parse(key) as { id: string; label: string; outgoing: boolean; other: string }[],
    [key],
  );
  if (!arrows.length) return null;
  return (
    <section className="card-arrows" aria-label="Arrows">
      <span className="eyebrow">Arrows</span>
      <ul>
        {arrows.map((arrow) => (
          <li key={arrow.id}>
            {arrow.outgoing ? (
              <>
                This card <strong>{arrow.label}</strong> {arrow.other}
              </>
            ) : (
              <>
                {arrow.other} <strong>{arrow.label}</strong> this card
              </>
            )}
            <button
              className="text-button"
              aria-label={`Remove arrow “${arrow.label}”`}
              onClick={() => onRemove(arrow.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
