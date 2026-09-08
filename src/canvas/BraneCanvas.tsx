import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  NodeResizer,
  Handle,
  Position,
  useReactFlow,
  type NodeProps,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Block, BraneState, Placement } from '../../shared/types/domain';
import { derivationEdges } from './derivations';
import { SpawnButton } from '../components/SpawnButton';
import { BlockContent } from '../components/BlockContent';
import { useInteraction } from '../stores/interaction';
type CardData = {
  block: Block;
  partial?: string;
  status?: string;
  newBlock?: string;
  spawning?: boolean;
  retrySpawn?: boolean;
  onSpawn: (blockId: string, placementId: string) => void;
  onEdit: (id: string, text: string) => void;
  onContext: (id: string) => void;
  onContinue: (id: string) => void;
  onGeometry: (id: string, g: Geometry) => void;
  onFocus: (id: string) => void;
  onManage: (id: string) => void;
};
type Geometry = Pick<Placement, 'x' | 'y' | 'width' | 'height'>;
type CardNode = Node<CardData>;
const addContext = (id: string) => useInteraction.getState().addReferences([id]);
const panButtons = [0, 1, 2];
const writeButtons = [1, 2];
const defaultViewport = { x: 20, y: 20, zoom: 1 };
function Card({ id, data, selected }: NodeProps<CardNode>) {
  return (
    <article className={`canvas-card ${data.block.origin} ${selected ? 'selected' : ''}`}>
      <Handle type="target" position={Position.Left} id="input" isConnectable={false} />
      <Handle type="source" position={Position.Right} id="output" isConnectable={false} />
      <NodeResizer isVisible={selected} minWidth={180} minHeight={120} />
      <header className="card-grip">
        <span className="kind-mark">{data.block.origin === 'generated' ? '✳' : '◇'}</span>
        <span>
          {data.block.origin === 'generated'
            ? 'Response'
            : data.block.kind === 'webpage'
              ? 'Web clipping'
              : data.block.kind === 'image'
                ? 'Image'
                : 'Thought'}
        </span>
        <span className="card-status">{data.status}</span>
        <button
          className="nodrag icon-button"
          title="Focus block"
          onClick={() => data.onFocus(data.block.id)}
        >
          ↗
        </button>
      </header>
      <BlockContent
        block={data.block}
        partial={data.partial}
        autoFocus={data.newBlock === data.block.id}
        onEdit={data.onEdit}
      />
      <footer className="nodrag">
        <button aria-label="Block actions" onClick={() => data.onManage(data.block.id)}>
          ⋯
        </button>
        <SpawnButton
          block={data.block}
          busy={data.spawning}
          retry={data.retrySpawn}
          onSpawn={() => data.onSpawn(data.block.id, id)}
        />
        <button onClick={() => data.onContext(data.block.id)}>+ Use as context</button>
        {data.block.messageId && (
          <button onClick={() => data.onContinue(data.block.messageId!)}>⑂ Continue</button>
        )}
      </footer>
    </article>
  );
}
const nodeTypes = { card: Card };
interface Props {
  state: BraneState;
  newBlock?: string;
  revealedBlock?: string;
  spawning: string[];
  retrySpawns: string[];
  onSpawn: CardData['onSpawn'];
  onCreate: (g: { x: number; y: number; width: number; height: number }) => void;
  onEdit: CardData['onEdit'];
  onGeometry: CardData['onGeometry'];
  onFocus: CardData['onFocus'];
  onManage: CardData['onManage'];
}
function Inner(props: Props) {
  const { screenToFlowPosition, fitView } = useReactFlow();
  const selected = useInteraction((s) => s.selectedPlacements);
  const tool = useInteraction((s) => s.tool);
  const setContinue = useInteraction((s) => s.setContinue);
  // Only in-progress geometry is local. Completed gestures update the domain owner.
  const [geometry, setGeometry] = useState<Record<string, Geometry>>({});
  const geometryRef = useRef(geometry);
  const [rect, setRect] = useState<{ x: number; y: number; width: number; height: number } | null>(
    null,
  );
  const start = useRef<{ clientX: number; clientY: number; x: number; y: number } | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const placements = props.state.placements;
  const placementsRef = useRef(placements);
  placementsRef.current = placements;
  useEffect(() => {
    // Removal is a domain event, not an echo from React Flow's rendered selection.
    const visible = new Set(placements.map((p) => p.id));
    const interaction = useInteraction.getState();
    interaction.setSelectedPlacements(
      interaction.selectedPlacements.filter((id) => visible.has(id)),
    );
    const previous = geometryRef.current;
    const remaining = Object.fromEntries(
      Object.entries(previous).filter(([id]) => visible.has(id)),
    );
    if (Object.keys(remaining).length !== Object.keys(previous).length) {
      geometryRef.current = remaining;
      setGeometry(remaining);
    }
  }, [placements]);
  const nodes = useMemo<CardNode[]>(() => {
    const blocks = new Map(props.state.blocks.map((b) => [b.id, b]));
    const runs = new Map(props.state.runs.map((r) => [r.output_block_id, r]));
    return placements.flatMap((p) => {
      const block = blocks.get(p.block_id);
      if (!block) return [];
      const run = runs.get(block.id);
      const g = geometry[p.id] ?? p;
      return [
        {
          id: p.id,
          type: 'card',
          position: { x: g.x, y: g.y },
          width: g.width,
          height: g.height,
          initialWidth: g.width,
          initialHeight: g.height,
          style: { width: g.width, height: g.height },
          dragHandle: '.card-grip',
          selected: selected.includes(p.id),
          data: {
            block,
            partial: run?.partial,
            status: run?.status,
            newBlock: props.newBlock,
            onEdit: props.onEdit,
            onSpawn: props.onSpawn,
            spawning: props.spawning.includes(block.id),
            retrySpawn: props.retrySpawns.includes(block.id),
            onContext: addContext,
            onContinue: setContinue,
            onGeometry: props.onGeometry,
            onFocus: props.onFocus,
            onManage: props.onManage,
          },
        },
      ];
    });
  }, [
    placements,
    props.state.blocks,
    props.state.runs,
    geometry,
    selected,
    props.newBlock,
    props.onEdit,
    props.onSpawn,
    props.spawning,
    props.retrySpawns,
    setContinue,
    props.onGeometry,
    props.onFocus,
    props.onManage,
  ]);
  const framed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!props.revealedBlock || framed.current === props.revealedBlock) return;
    const related = props.state.derivations.filter((d) => d.outputBlockId === props.revealedBlock);
    const connections = derivationEdges(props.state).filter((e) =>
      related.some((d) => e.id === `${d.runId}:${d.position}`),
    );
    const ids = new Set(connections.flatMap((e) => [e.source, e.target]));
    const visible = nodes.filter((n) => ids.has(n.id));
    if (!visible.length) return;
    const frame = requestAnimationFrame(() => {
      void fitView({ nodes: visible, padding: 0.25, maxZoom: 1, duration: 250 });
      framed.current = props.revealedBlock;
    });
    return () => cancelAnimationFrame(frame);
  }, [props.revealedBlock, props.state, nodes, fitView]);
  const edges = useMemo(
    () => derivationEdges(props.state),
    [props.state.placements, props.state.derivations],
  );
  const changes = useCallback(
    (updates: NodeChange<CardNode>[]) => {
      const byId = new Map(placementsRef.current.map((p) => [p.id, p]));
      const interaction = useInteraction.getState();
      const selection = new Set(interaction.selectedPlacements);
      let nextGeometry = geometryRef.current;
      const completed = new Set<string>();
      for (const change of updates) {
        if (!('id' in change)) continue;
        const placement = byId.get(change.id);
        if (!placement) continue;
        if (change.type === 'select') {
          if (change.selected) selection.add(placement.id);
          else selection.delete(placement.id);
        } else if (
          change.type === 'position' ||
          (change.type === 'dimensions' && change.resizing !== undefined)
        ) {
          const previous = nextGeometry[change.id] ?? placement;
          const next = {
            x: previous.x,
            y: previous.y,
            width: previous.width,
            height: previous.height,
          };
          if (change.type === 'position' && change.position) Object.assign(next, change.position);
          if (change.type === 'dimensions' && change.dimensions)
            Object.assign(next, change.dimensions);
          nextGeometry = { ...nextGeometry, [change.id]: next };
          if (
            (change.type === 'position' && change.dragging === false) ||
            (change.type === 'dimensions' && change.resizing === false)
          )
            completed.add(change.id);
        }
      }
      interaction.setSelectedPlacements([...selection]);
      for (const id of completed) {
        props.onGeometry(id, nextGeometry[id]);
        nextGeometry = { ...nextGeometry };
        delete nextGeometry[id];
      }
      if (nextGeometry !== geometryRef.current) {
        geometryRef.current = nextGeometry;
        setGeometry(nextGeometry);
      }
    },
    [props.onGeometry],
  );
  return (
    <div
      className={`canvas-host tool-${tool}`}
      ref={host}
      onPointerDownCapture={(e) => {
        if (
          tool !== 'write' ||
          e.button !== 0 ||
          !(e.target as HTMLElement).classList.contains('react-flow__pane') ||
          e.shiftKey
        )
          return;
        const bounds = host.current!.getBoundingClientRect();
        start.current = {
          clientX: e.clientX,
          clientY: e.clientY,
          x: e.clientX - bounds.left,
          y: e.clientY - bounds.top,
        };
        host.current!.setPointerCapture(e.pointerId);
        e.preventDefault();
        e.stopPropagation();
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const s = start.current;
        setRect({
          x: Math.min(s.x, s.x + e.clientX - s.clientX),
          y: Math.min(s.y, s.y + e.clientY - s.clientY),
          width: Math.abs(e.clientX - s.clientX),
          height: Math.abs(e.clientY - s.clientY),
        });
      }}
      onPointerUp={(e) => {
        const s = start.current;
        if (!s) return;
        start.current = null;
        setRect(null);
        host.current!.releasePointerCapture(e.pointerId);
        if (Math.abs(e.clientX - s.clientX) < 8 && Math.abs(e.clientY - s.clientY) < 8) return;
        const a = screenToFlowPosition({
            x: Math.min(s.clientX, e.clientX),
            y: Math.min(s.clientY, e.clientY),
          }),
          b = screenToFlowPosition({
            x: Math.max(s.clientX, e.clientX),
            y: Math.max(s.clientY, e.clientY),
          });
        props.onCreate({
          x: a.x,
          y: a.y,
          width: Math.max(220, b.x - a.x),
          height: Math.max(160, b.y - a.y),
        });
      }}
      onPointerCancel={() => {
        start.current = null;
        setRect(null);
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={changes}
        panOnDrag={tool === 'pan' ? panButtons : writeButtons}
        selectionOnDrag={false}
        multiSelectionKeyCode="Shift"
        deleteKeyCode={null}
        nodesConnectable={false}
        minZoom={0.2}
        maxZoom={2}
        defaultViewport={defaultViewport}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#cfcec6" />
        <Controls showInteractive={false} />
      </ReactFlow>
      {rect && (
        <div
          className="draft-rectangle"
          style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
        />
      )}
      <div className="canvas-hint">
        Drag to make a thought <span>·</span> Shift-click to select several <span>·</span> Pan with
        middle mouse
      </div>
    </div>
  );
}
export function BraneCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
