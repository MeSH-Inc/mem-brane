import { memo, useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { MAX_GROUP_LABEL } from '../../shared/groups';
import { CardPort } from './MachineCard';

export type GroupData = {
  groupId: string;
  label: string;
  display: 'region' | 'stack';
  count: number;
  // Every member is selected.
  chosen: boolean;
  onFeed: (groupId: string, toPlacementId: string, slot: string) => void;
  onRename: (groupId: string, label: string) => void;
};
export type GroupNode = Node<GroupData, 'cardGroup'>;

// The frame of a group: a dashed region round its cards, or the edge of a stack. Only
// its header takes the pointer: pressing it selects the group, dragging it moves every
// member, and its port feeds the whole group to a slot. The area inside belongs to the
// table, so selecting and drawing work inside a region as anywhere else.
export const GroupFrame = memo(function GroupFrame({ data }: NodeProps<GroupNode>) {
  const [naming, setNaming] = useState<string>();
  return (
    <section
      className={`group-frame ${data.display}${data.chosen ? ' chosen' : ''}`}
      aria-label={data.label}
      aria-roledescription="group"
    >
      <Handle type="source" position={Position.Right} id="output" isConnectable={false} />
      <header className="group-header">
        {naming === undefined ? (
          <>
            <span className="group-label">{data.label}</span>
            <span className="group-count">
              {data.display === 'stack' ? `Stack · ${data.count}` : `${data.count} cards`}
            </span>
            <button
              className="icon-button"
              aria-label={`Rename ${data.label}`}
              title="Rename this group"
              onClick={() => setNaming(data.label)}
            >
              ✎
            </button>
          </>
        ) : (
          <form
            data-canvas-native
            onSubmit={(event) => {
              event.preventDefault();
              if (naming.trim() && naming.trim() !== data.label)
                data.onRename(data.groupId, naming);
              setNaming(undefined);
            }}
          >
            <input
              aria-label="Group name"
              autoFocus
              maxLength={MAX_GROUP_LABEL}
              value={naming}
              onChange={(event) => setNaming(event.target.value)}
              onBlur={(event) => event.currentTarget.form?.requestSubmit()}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  setNaming(undefined);
                }
              }}
            />
          </form>
        )}
        <CardPort
          owner={`group:${data.groupId}`}
          title="Drag onto a machine slot to feed it every card in this group"
          onFeed={(machine, slot) => data.onFeed(data.groupId, machine, slot)}
        />
      </header>
    </section>
  );
});
