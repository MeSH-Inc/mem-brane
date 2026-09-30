import { memo } from 'react';
import { useStore } from 'zustand';
import type { WorkspaceDocument } from '../services/workspace-document';
import { ResponseContent, type ResponseActions } from './ResponseContent';
import { BlockContent } from './BlockContent';
export const LiveBlockContent = memo(function LiveBlockContent({
  document,
  blockId,
  onEdit,
  focusRequest,
  onFocused,
  onStop,
  onRetry,
}: ResponseActions & {
  document: WorkspaceDocument;
  blockId: string;
  onEdit: (id: string, text: string) => void;
  focusRequest?: string;
  onFocused?: (id: string) => void;
}) {
  const block = useStore(document.store, (s) => s.blocks[blockId]);
  const run = useStore(document.store, (s) => s.runs[blockId]);
  if (block?.origin === 'generated')
    return (
      <ResponseContent
        key={block.id}
        text={block.content.text}
        run={run}
        onStop={onStop}
        onRetry={onRetry}
      />
    );
  return block ? (
    <BlockContent block={block} onEdit={onEdit} focusRequest={focusRequest} onFocused={onFocused} />
  ) : null;
});
