import { memo } from 'react';
import { useStore } from 'zustand';
import type { WorkspaceDocument } from '../services/workspace-document';
import { BlockContent } from './BlockContent';
export const LiveBlockContent = memo(function LiveBlockContent({
  document,
  blockId,
  onEdit,
  focusRequest,
  onFocused,
}: {
  document: WorkspaceDocument;
  blockId: string;
  onEdit: (id: string, text: string) => void;
  focusRequest?: string;
  onFocused?: (id: string) => void;
}) {
  const block = useStore(document.store, (s) => s.blocks[blockId]);
  const partial = useStore(document.store, (s) => s.runs[blockId]?.partial);
  return block ? (
    <BlockContent
      block={block}
      partial={partial}
      onEdit={onEdit}
      focusRequest={focusRequest}
      onFocused={onFocused}
    />
  ) : null;
});
