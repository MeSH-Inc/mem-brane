import { useState } from 'react';
import type { Block } from '../../shared/types/domain';
import type { Draft, DiscardDraftResult } from '../services/drafts';

export function SavedDrafts({
  drafts,
  blocks,
  onRefresh,
  onRecover,
  onDiscard,
}: {
  drafts: Draft[];
  blocks: Block[];
  onRefresh: () => Promise<void>;
  onRecover: (draft: Draft) => void;
  onDiscard: (draft: Draft) => Promise<DiscardDraftResult>;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  async function discard(draft: Draft) {
    setBusy(true);
    setNotice('');
    setError('');
    try {
      const result = await onDiscard(draft);
      setNotice(
        result === 'changed'
          ? 'This copy changed elsewhere and was kept. Review the refreshed copy before removing it.'
          : result === 'missing'
            ? 'This saved copy was already removed.'
            : 'Saved copy removed.',
      );
    } catch (error) {
      setError(`Could not remove this saved copy. ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="draft-recovery">
      <summary>Other saved drafts ({drafts.length})</summary>
      <button disabled={busy} onClick={() => void onRefresh()}>
        Refresh saved drafts
      </button>
      <p>
        Recover a copy to edit here. Remove saved copy deletes only the copy shown below; it does
        not change the block or an open editor.
      </p>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {!drafts.length && <p>No other saved drafts in this brane.</p>}
      {drafts.map((draft) => {
        const block = blocks.find((block) => block.id === draft.blockId);
        return (
          <section key={draft.key} aria-label="Saved draft">
            <strong>
              Block {draft.blockId.slice(0, 8)} · {block?.content.text.slice(0, 60) || block?.kind}
            </strong>
            <div>
              <small>
                {new Date(draft.updatedAt).toLocaleString()} · version {draft.baseVersion} · copy{' '}
                {draft.key.slice(0, 8)}
              </small>
            </div>
            <pre>{draft.text}</pre>
            <button disabled={busy} onClick={() => onRecover(draft)}>
              Recover a copy
            </button>
            <button disabled={busy} onClick={() => void discard(draft)}>
              Remove saved copy
            </button>
          </section>
        );
      })}
    </details>
  );
}
