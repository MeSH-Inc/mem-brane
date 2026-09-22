import { memo, useMemo } from 'react';
import { useStore } from 'zustand';
import type { WorkspaceDocument } from '../services/workspace-document';
import type { Block } from '../../shared/types/domain';

const cardLabel = (block: Block) =>
  block.content.text.trim().slice(0, 28) ||
  (block.origin === 'generated' ? 'Response' : block.kind === 'text' ? 'Thought' : block.kind);

// Shows what a response was built from and whether those inputs have moved on since.
// Rerunning is always an explicit action; a changed source never regenerates anything.
export const ResponseSources = memo(function ResponseSources({
  document,
  blockId,
  onOpenSource,
  onInspect,
  onRerun,
}: {
  document: WorkspaceDocument;
  blockId: string;
  onOpenSource: (blockId: string) => void;
  onInspect: (runId: string) => void;
  onRerun: (runId: string) => void;
}) {
  const derivations = useStore(document.store, (s) => s.scene.derivations);
  const mine = useMemo(
    () => derivations.filter((d) => d.outputBlockId === blockId),
    [derivations, blockId],
  );
  // A primitive summary keeps unrelated block updates from re-rendering the card.
  const summary = useStore(document.store, (s) =>
    JSON.stringify(
      mine.map((d) => {
        const source = s.blocks[d.sourceBlockId];
        return source
          ? [cardLabel(source), d.sourceVersion !== null && source.version !== d.sourceVersion]
          : [null, false];
      }),
    ),
  );
  if (!mine.length) return null;
  const entries = JSON.parse(summary) as [string | null, boolean][];
  const runId = mine[0].runId;
  const changed = entries.some(([, stale]) => stale);
  return (
    <div className="response-sources nodrag nopan" aria-label="Based on">
      <span className="eyebrow">Based on</span>
      {mine.map((d, i) => {
        const [label, stale] = entries[i] ?? [null, false];
        return (
          <button
            key={`${d.runId}:${d.position}`}
            className={`source-chip${stale ? ' changed' : ''}`}
            disabled={!label}
            title={
              !label
                ? 'This source is not on this brane'
                : stale
                  ? 'Edited since this response was generated'
                  : 'Unchanged since this response was generated'
            }
            onClick={() => onOpenSource(d.sourceBlockId)}
          >
            {i + 1} · {label ?? 'Not on this brane'}
            {stale && <em> · changed</em>}
          </button>
        );
      })}
      <button className="text-button" onClick={() => onInspect(runId)}>
        Exact inputs
      </button>
      {changed && (
        <button className="text-button rerun" onClick={() => onRerun(runId)}>
          {mine[0].kind === 'source' ? 'Develop again' : 'Reuse with current sources'}
        </button>
      )}
    </div>
  );
});
