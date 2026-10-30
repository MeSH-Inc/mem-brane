import { memo, useEffect, useRef, type ReactNode } from 'react';
import type { Node, NodeProps } from '@xyflow/react';

// Where the Ask box stands on the table. Its answer is placed in the same spot.
export interface AskPosition {
  id: string;
  x: number;
  y: number;
}
export const ASK_WIDTH = 380;
export const ASK_HEIGHT = 300;
export type AskData = {
  content: ReactNode;
  onClose: () => void;
};
export type AskNode = Node<AskData, 'ask'>;

// The prompt, on the table beside what it asks about. It is not a card: nothing is
// stored until it runs, and closing it keeps the draft for the next time it opens.
export const AskBox = memo(function AskBox({ data }: NodeProps<AskNode>) {
  const box = useRef<HTMLElement>(null);
  // React Flow shows a node only once it has measured it; focus as soon as it shows.
  useEffect(() => {
    let frame = 0,
      attempts = 0;
    const focus = () => {
      const input = box.current?.querySelector<HTMLTextAreaElement>('textarea');
      input?.focus({ preventScroll: true });
      if (globalThis.document.activeElement !== input && attempts++ < 20)
        frame = requestAnimationFrame(focus);
    };
    frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <section
      ref={box}
      className="ask-box nodrag nopan"
      data-canvas-native
      aria-label="Ask"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          data.onClose();
        }
      }}
    >
      <header>
        <span className="eyebrow">Ask</span>
        <button className="text-button" aria-label="Close Ask" onClick={data.onClose}>
          ×
        </button>
      </header>
      {data.content}
    </section>
  );
});
