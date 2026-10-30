import { memo, useMemo } from 'react';
import { useStore } from 'zustand';
import type { WorkspaceDocument } from '../services/workspace-document';
import { LiveBlockContent } from '../components/LiveBlockContent';
import { ResponseSources } from '../components/ResponseSources';
import type { ResponseActions } from '../components/ResponseContent';
import { statusLabels } from '../lib/labels';

export interface BackActions extends ResponseActions {
  onDetach: (placementId: string) => void;
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
    JSON.stringify(backItems(s.scene.placements, s.runs, placementId)),
  );
  const held = useMemo(() => JSON.parse(heldKey) as BackItem[], [heldKey]);
  return (
    <div className="card-back nodrag nopan" aria-label="Card back">
      {generated && (
        <section className="back-receipt" aria-label="Receipt">
          <span className="eyebrow">Receipt</span>
          {receipt && <p className="back-meta">{receipt}</p>}
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
export function backItems(
  placements: { id: string; block_id: string; host_placement_id: string | null }[],
  runs: Record<string, { id: string; created_at: number; machine_block_id: string | null }>,
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
        earlier: !!run?.machine_block_id,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}
