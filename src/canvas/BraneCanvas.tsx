import { pasteFiles, dropFiles, allowFileDrop } from '../services/import-adapters';
import { toolPolicy } from './toolPolicy';
import { useCanvasGesture } from './useCanvasGesture';
import { defaultViewport, type ResizeEdge } from './gestures';
import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  useReactFlow,
  type NodeProps,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { Placement } from '../../shared/types/domain';
import { derivationEdges } from './derivations';
import { SpawnButton } from '../components/SpawnButton';
import { LiveBlockContent } from '../components/LiveBlockContent';
import { idleActivity, type WorkspaceDocument } from '../services/workspace-document';
import { useInteraction } from '../stores/interaction';
import { presentationFor } from '../stores/presentation';
import { useStore } from 'zustand';
type CardData = {
  blockId: string;
  document: WorkspaceDocument;
  focusRequest?: string;
  onFocused: (id: string) => void;
  resizable: boolean;
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
const Card = memo(function Card({ id, data, selected }: NodeProps<CardNode>) {
  const block = useStore(data.document.store, (s) => s.blocks[data.blockId]);
  const status = useStore(data.document.store, (s) => s.runs[data.blockId]?.status);
  const activity = useStore(data.document.store, (s) => s.activity[data.blockId] ?? idleActivity);
  if (!block) return null;
  return (
    <article className={`canvas-card ${block.origin} ${selected ? 'selected' : ''}`}>
      <Handle type="target" position={Position.Left} id="input" isConnectable={false} />
      <Handle type="source" position={Position.Right} id="output" isConnectable={false} />
      {selected &&
        data.resizable &&
        (['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as ResizeEdge[]).map((edge) => (
          <span
            key={edge}
            className={`canvas-resize ${edge}`}
            data-resize={edge}
            aria-hidden="true"
          />
        ))}
      <header className="card-grip">
        <span className="kind-mark">{block.origin === 'generated' ? '✳' : '◇'}</span>
        <span>
          {block.origin === 'generated'
            ? 'Response'
            : block.kind === 'webpage'
              ? 'Web clipping'
              : block.kind === 'pdf'
                ? 'PDF'
                : block.kind === 'image'
                  ? 'Image'
                  : 'Thought'}
        </span>
        <span className="card-status">{status}</span>
        <button
          className="nodrag nopan icon-button"
          title="Focus block"
          onClick={() => data.onFocus(block.id)}
        >
          ↗
        </button>
      </header>
      <LiveBlockContent
        document={data.document}
        blockId={block.id}
        focusRequest={data.focusRequest}
        onFocused={data.onFocused}
        onEdit={data.onEdit}
      />
      <footer className="nodrag nopan">
        <button aria-label="Block actions" onClick={() => data.onManage(block.id)}>
          ⋯
        </button>
        <SpawnButton
          block={block}
          busy={activity.busy}
          phase={activity.phase}
          retry={activity.retry}
          onSpawn={() => data.onSpawn(block.id, id)}
        />
        <button onClick={() => data.onContext(block.id)}>+ Use as context</button>
        {block.messageId && (
          <button onClick={() => data.onContinue(block.messageId!)}>⑂ Continue</button>
        )}
      </footer>
    </article>
  );
});
const nodeTypes = { card: Card };
interface Props {
  onContext: (ids: string[]) => void;
  onContinue: (id: string) => void;
  onImport?: (files: File[], point?: { x: number; y: number }) => void;
  onInsertionReady?: (getPoint: () => { x: number; y: number }) => void;
  document: WorkspaceDocument;
  onSpawn: CardData['onSpawn'];
  onCreate: (g: { x: number; y: number; width: number; height: number }) => void;
  onEdit: CardData['onEdit'];
  onGeometry: CardData['onGeometry'];
  onFocus: CardData['onFocus'];
  onManage: CardData['onManage'];
}
function Inner(props: Props) {
  const { screenToFlowPosition, fitView, getViewport, setViewport } = useReactFlow();
  const scene = useStore(props.document.store, (s) => s.scene);
  const actor = useInteraction((s) => s.actor);
  const presentation = presentationFor(actor, scene.braneId);
  const request = useStore(presentation, (s) => s.request);
  const [initialViewport] = useState(() => presentation.getState().viewport);
  const rememberViewport = useCallback(
    (_: unknown, viewport: typeof defaultViewport) =>
      presentation.getState().remember({ viewport }),
    [presentation],
  );
  const selected = useInteraction((s) => s.selectedPlacements);
  const tool = useInteraction((s) => s.tool);
  const addContext = useCallback((id: string) => props.onContext([id]), [props.onContext]);
  const setContinue = props.onContinue;
  const policy = toolPolicy(tool);
  const host = useRef<HTMLDivElement>(null);
  const placements = scene.placements;
  const {
    geometry,
    rectangle: rect,
    bindings,
  } = useCanvasGesture(tool, host, {
    placements: () => placements,
    selection: () => useInteraction.getState().selectedPlacements,
    select: useInteraction.getState().setSelectedPlacements,
    viewport: getViewport,
    camera: (view) => {
      void setViewport(view);
    },
    create: props.onCreate,
    commit: props.onGeometry,
  });
  const insertion = useCallback(() => {
    const bounds = host.current?.getBoundingClientRect();
    const point = screenToFlowPosition(
      bounds
        ? { x: bounds.left + bounds.width / 2 - 160, y: bounds.top + bounds.height / 2 - 150 }
        : { x: 100, y: 100 },
    );
    return point;
  }, [screenToFlowPosition]);
  useEffect(() => {
    props.onInsertionReady?.(insertion);
  }, [props.onInsertionReady, insertion]);
  useEffect(() => {
    const visible = new Set(placements.map((p) => p.id));
    const interaction = useInteraction.getState();
    interaction.setSelectedPlacements(
      interaction.selectedPlacements.filter((id) => visible.has(id)),
    );
  }, [placements]);
  const nodeCache = useRef(new Map<string, CardNode>());
  const nodes = useMemo<CardNode[]>(() => {
    const visible = new Set(placements.map((p) => p.id));
    for (const id of nodeCache.current.keys()) if (!visible.has(id)) nodeCache.current.delete(id);
    return placements.map((p) => {
      const g = geometry[p.id] ?? p;
      const next: CardNode = {
        id: p.id,
        type: 'card',
        position: { x: g.x, y: g.y },
        width: g.width,
        height: g.height,
        initialWidth: g.width,
        initialHeight: g.height,
        style: { width: g.width, height: g.height, pointerEvents: 'all' },
        dragHandle: '.card-grip',
        selected: selected.includes(p.id),
        data: {
          blockId: p.block_id,
          document: props.document,
          resizable: tool !== 'pan',
          focusRequest:
            request?.kind === 'edit' &&
            request.blockId === p.block_id &&
            (!request.placementId || request.placementId === p.id)
              ? request.id
              : undefined,
          onFocused: presentation.getState().consume,
          onEdit: props.onEdit,
          onSpawn: props.onSpawn,
          onContext: addContext,
          onContinue: setContinue,
          onGeometry: props.onGeometry,
          onFocus: props.onFocus,
          onManage: props.onManage,
        },
      };
      const previous = nodeCache.current.get(p.id);
      if (
        previous &&
        previous.position.x === next.position.x &&
        previous.position.y === next.position.y &&
        previous.width === next.width &&
        previous.height === next.height &&
        previous.selected === next.selected &&
        (Object.keys(next.data) as (keyof CardData)[]).every(
          (key) => previous.data[key] === next.data[key],
        )
      )
        return previous;
      nodeCache.current.set(p.id, next);
      return next;
    });
  }, [
    placements,
    tool,
    props.document,
    geometry,
    selected,
    request,
    presentation,
    props.onEdit,
    props.onSpawn,
    addContext,
    setContinue,
    props.onGeometry,
    props.onFocus,
    props.onManage,
  ]);
  useEffect(() => {
    if (!request || request.kind !== 'reveal') return;
    const connections = derivationEdges(scene);
    const output = scene.placements.filter((p) => p.block_id === request.blockId).map((p) => p.id);
    const ids = new Set([
      ...output,
      ...connections.filter((e) => output.includes(e.target)).map((e) => e.source),
    ]);
    const visible = nodes.filter((n) => ids.has(n.id));
    if (!visible.length) return;
    const frame = requestAnimationFrame(() => {
      if (presentation.getState().request?.id !== request.id) return;
      void fitView({ nodes: visible, padding: 0.25, maxZoom: 1, duration: 0 });
      presentation.getState().consume(request.id);
    });
    return () => cancelAnimationFrame(frame);
  }, [request, scene.placements, scene.derivations, nodes, fitView, presentation]);
  const edges = useMemo(() => derivationEdges(scene), [scene.placements, scene.derivations]);
  return (
    <div
      ref={host}
      tabIndex={0}
      aria-label="Artifact canvas"
      className={`canvas-host tool-${tool}`}
      {...bindings}
      onPaste={(event) =>
        pasteFiles(event, (files) => {
          const node = (event.target as HTMLElement).closest('[data-id]');
          const placement = scene.placements.find((p) => p.id === node?.getAttribute('data-id'));
          props.onImport?.(
            files,
            placement ? { x: placement.x + placement.width + 30, y: placement.y } : insertion(),
          );
        })
      }
      onDragOver={allowFileDrop}
      onDrop={(event) =>
        dropFiles(event, (files) =>
          props.onImport?.(files, screenToFlowPosition({ x: event.clientX, y: event.clientY })),
        )
      }
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        elementsSelectable={false}
        selectionOnDrag={false}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        panOnScroll={false}
        selectionKeyCode={null}
        panActivationKeyCode={null}
        multiSelectionKeyCode={null}
        disableKeyboardA11y
        autoPanOnNodeFocus={false}
        edgesFocusable={false}
        preventScrolling={false}
        deleteKeyCode={null}
        nodesConnectable={false}
        minZoom={0.2}
        maxZoom={2}
        defaultViewport={initialViewport}
        onMove={rememberViewport}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#cfcec6" />
        <Controls showInteractive={false} />
      </ReactFlow>
      {rect && (
        <div
          className={rect.kind === 'write' ? 'draft-rectangle' : 'selection-rectangle'}
          style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
        />
      )}
      <div className="canvas-hint">{policy.hint} </div>
    </div>
  );
}
export const BraneCanvas = memo(function BraneCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
});
