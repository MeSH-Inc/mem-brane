import { MAX_BLOCK_TEXT_CHARACTERS } from '../../shared/limits';
import { useEffect, useRef } from 'react';
import type { Block } from '../../shared/types/domain';
import { useInteraction } from '../stores/interaction';
export function BlockContent({
  block,
  partial,
  autoFocus,
  onEdit,
}: {
  block: Block;
  partial?: string;
  autoFocus?: boolean;
  onEdit: (id: string, text: string) => void;
}) {
  const draft = useInteraction((s) => s.drafts[block.id]);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    let frame = 0,
      attempts = 0;
    const focus = () => {
      const editor = ref.current;
      if (!editor) return;
      if (getComputedStyle(editor).visibility !== 'hidden') {
        editor.focus({ preventScroll: true });
      } else if (attempts++ < 30) {
        frame = requestAnimationFrame(focus);
      }
    };
    frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, [autoFocus]);
  if (block.kind === 'image')
    return (
      <figure className="image-content">
        <img src={`/api/assets/${block.content.assetId}`} alt={block.content.text} />
        <figcaption>{block.content.text}</figcaption>
      </figure>
    );
  if (block.origin === 'generated')
    return (
      <div className="response-content nodrag nowheel nopan">
        {block.content.text || partial || <span className="muted">Thinking space reserved…</span>}
      </div>
    );
  return (
    <>
      {block.content.url && (
        <a
          className="source-link nodrag nopan"
          href={/^https?:\/\//.test(block.content.url) ? block.content.url : undefined}
          target="_blank"
          rel="noreferrer"
        >
          {block.content.url}
        </a>
      )}
      {block.content.status === 'pending' && <small>Importing webpage…</small>}
      {block.content.error && <small className="error">{block.content.error}</small>}
      <textarea
        ref={ref}
        maxLength={MAX_BLOCK_TEXT_CHARACTERS}
        aria-label={block.kind === 'webpage' ? 'Webpage text' : 'Block text'}
        className="block-editor nodrag nowheel nopan"
        value={draft ?? block.content.text}
        placeholder="Let a thought take shape…"
        onChange={(e) => onEdit(block.id, e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      />
    </>
  );
}
