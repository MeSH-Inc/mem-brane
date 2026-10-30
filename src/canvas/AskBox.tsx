import { memo, useEffect, useRef, useState } from 'react';
import type { Node, NodeProps } from '@xyflow/react';

export interface AskRequest {
  id: string;
  references: string[];
  x: number;
  y: number;
}
export const ASK_HEIGHT = 300;
export type AskData = {
  count: number;
  busy: boolean;
  onAsk: (prompt: string) => void;
  onCancel: () => void;
};
export type AskNode = Node<AskData, 'ask'>;
export const ASK_WIDTH = 380;

// A question asked of the selected cards, at their edge. It is not a card: nothing is
// stored until it runs, and its answer is placed where it stood.
export const AskBox = memo(function AskBox({ data }: NodeProps<AskNode>) {
  const [prompt, setPrompt] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  // React Flow shows a node only once it has measured it; focus as soon as it shows.
  useEffect(() => {
    let frame = 0,
      attempts = 0;
    const focus = () => {
      input.current?.focus({ preventScroll: true });
      if (globalThis.document.activeElement !== input.current && attempts++ < 20)
        frame = requestAnimationFrame(focus);
    };
    frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, []);
  const submit = () => {
    if (prompt.trim() && !data.busy) data.onAsk(prompt.trim());
  };
  return (
    <form
      className="ask-box nodrag nopan"
      data-canvas-native
      aria-label="Ask"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          data.onCancel();
        } else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          submit();
        }
      }}
    >
      <span className="eyebrow">
        Ask about {data.count === 1 ? '1 card' : `${data.count} cards`}
      </span>
      <textarea
        ref={input}
        aria-label="Ask prompt"
        placeholder="What do you want to know?"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
      />
      <footer>
        <button type="button" className="text-button" onClick={data.onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={!prompt.trim() || data.busy}>
          {data.busy ? 'Asking…' : 'Ask ↗'}
        </button>
      </footer>
    </form>
  );
});
