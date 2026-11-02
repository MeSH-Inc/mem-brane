import { LocalImage } from './LocalAsset';
import { PdfContent } from './PdfContent';
import { MAX_BLOCK_TEXT_CHARACTERS } from '../../shared/limits';
import { useEffect, useRef, useState } from 'react';
import type { Block } from '../../shared/types/domain';
import { useInteraction } from '../stores/interaction';
export function BlockContent({
  block,
  focusRequest,
  onFocused,
  onEdit,
  onQuote,
}: {
  block: Block;
  focusRequest?: string;
  onFocused?: (id: string) => void;
  onEdit: (id: string, text: string) => void;
  // A passage selected in a PDF or webpage card becomes a card of its own.
  onQuote?: (blockId: string, passage: Passage) => void;
}) {
  const draft = useInteraction((s) => s.drafts[block.id]);
  // The passage selected in the webpage's text, quoted by the Quote button or by Q.
  const [selected, setSelected] = useState<string>();
  const ref = useRef<HTMLTextAreaElement>(null);
  const focused = useRef(onFocused);
  focused.current = onFocused;
  useEffect(() => {
    if (!focusRequest) return;
    let frame = 0,
      attempts = 0;
    const focus = () => {
      const editor = ref.current;
      if (!editor) return;
      if (getComputedStyle(editor).visibility !== 'hidden') {
        editor.focus({ preventScroll: true });
        focused.current?.(focusRequest);
      } else if (attempts++ < 30) {
        frame = requestAnimationFrame(focus);
      }
    };
    frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, [focusRequest]);
  if (block.content.format === 'pdf')
    return (
      <PdfContent
        content={block.content}
        onQuote={onQuote && ((passage) => onQuote(block.id, passage))}
      />
    );
  const quotable = block.kind === 'webpage' && !!onQuote;
  const quote = () => {
    if (!selected || !onQuote) return;
    onQuote(block.id, { text: selected });
    setSelected(undefined);
    ref.current?.setSelectionRange(ref.current.selectionEnd, ref.current.selectionEnd);
  };
  if (block.kind === 'image')
    return (
      <figure className="image-content">
        <LocalImage assetId={block.content.assetId!} alt={block.content.text} />
        <figcaption>{block.content.text}</figcaption>
      </figure>
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
        aria-label={
          block.kind === 'webpage'
            ? 'Webpage text'
            : block.kind === 'machine'
              ? 'Machine prompt'
              : 'Block text'
        }
        className="block-editor nodrag nowheel nopan"
        value={draft ?? block.content.text}
        placeholder={
          block.kind === 'machine'
            ? 'Write a prompt and name its inputs in braces, like {claim}.'
            : 'Let a thought take shape…'
        }
        onChange={(e) => onEdit(block.id, e.target.value)}
        onSelect={
          quotable
            ? (e) => {
                const editor = e.currentTarget;
                const text = editor.value.slice(editor.selectionStart, editor.selectionEnd).trim();
                setSelected(text || undefined);
              }
            : undefined
        }
        onKeyDown={(e) => {
          e.stopPropagation();
          // Q quotes a selected passage rather than typing over it.
          if (quotable && selected && isQuoteKey(e)) {
            e.preventDefault();
            quote();
          }
        }}
        onPointerDown={(e) => e.stopPropagation()}
      />
      {quotable && selected && <QuoteButton onQuote={quote} />}
    </>
  );
}

export interface Passage {
  text: string;
  // The PDF page the passage was selected on.
  page?: number;
}
export const isQuoteKey = (event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}) => event.key.toLowerCase() === 'q' && !event.metaKey && !event.ctrlKey && !event.altKey;
export function QuoteButton({ onQuote }: { onQuote: () => void }) {
  return (
    <button
      type="button"
      className="quote-button nodrag nopan"
      title="Put the selected passage on a card of its own, citing this one (Q)"
      // The selection must survive the press.
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={onQuote}
    >
      ❝ Quote
    </button>
  );
}
