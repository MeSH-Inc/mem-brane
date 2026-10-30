import { ActionMenu } from '../components/ActionMenu';
import { pasteFiles, dropFiles, allowFileDrop } from '../services/import-adapters';
import { useCanvasGesture } from './useCanvasGesture';
import { defaultViewport, type ResizeEdge } from './gestures';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useContext,
  memo,
  Profiler,
} from 'react';
import { RenderObserver } from '../lib/render-observer';
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
import { derivationEdges, machineEdges } from './derivations';
import { MachineCard, FeedPort, type MachineActions } from './MachineCard';
import { machineStaleness } from './machines';
import { CardBack, type BackActions } from './CardBack';
import { AskBox, ASK_WIDTH, type AskNode, type AskRequest } from './AskBox';
import { SpawnButton } from '../components/SpawnButton';
import type { CardAction } from '../components/ArtifactActions';
import { LiveBlockContent } from '../components/LiveBlockContent';
import type { ResponseActions } from '../components/ResponseContent';
import { cardKind } from '../lib/labels';
import { idleActivity, type WorkspaceDocument } from '../services/workspace-document';
import { useInteraction } from '../stores/interaction';
import { presentationFor } from '../stores/presentation';
import { useStore } from 'zustand';
type CardData = ResponseActions & {
  mobile: boolean;
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
  onManage: (blockId: string, placementId: string, view: CardAction) => void;
  onOpenSource: (blockId: string) => void;
  onInspect: (runId: string) => void;
  onRerun: (runId: string) => void;
  onDetach: (placementId: string) => void;
  onReuse: (runId: string, question: string) => void;
  machine: MachineActions;
};
type Geometry = Pick<Placement, 'x' | 'y' | 'width' | 'height'>;
type CardNode = Node<CardData>;
const Card = memo(function Card({ id, data, selected }: NodeProps<CardNode>) {
  const block = useStore(data.document.store, (s) => s.blocks[data.blockId]);
  const activity = useStore(data.document.store, (s) => s.activity[data.blockId] ?? idleActivity);
  const observer = useContext(RenderObserver);
  const flipped = useInteraction((s) => s.flipped.includes(id));
  const held = useStore(
    data.document.store,
    (s) => s.scene.placements.filter((p) => p.host_placement_id === id).length,
  );
  // An input edited since this card was generated marks the flip control, whose back
  // holds the receipt that says which.
  const changed = useStore(data.document.store, (s) =>
    s.scene.derivations.some(
      (d) =>
        d.outputBlockId === data.blockId &&
        d.sourceVersion !== null &&
        !!s.blocks[d.sourceBlockId] &&
        s.blocks[d.sourceBlockId].version !== d.sourceVersion,
    ),
  );
  const back = useMemo<BackActions>(
    () => ({
      onDetach: data.onDetach,
      onReuse: data.onReuse,
      onOpenSource: data.onOpenSource,
      onInspect: data.onInspect,
      onRerun: data.onRerun,
      onStop: data.onStop,
      onRetry: data.onRetry,
    }),
    [
      data.onDetach,
      data.onReuse,
      data.onOpenSource,
      data.onInspect,
      data.onRerun,
      data.onStop,
      data.onRetry,
    ],
  );
  if (!block) return null;
  const resize =
    selected &&
    data.resizable &&
    (['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as ResizeEdge[]).map((edge) => (
      <span key={edge} className={`canvas-resize ${edge}`} data-resize={edge} aria-hidden="true" />
    ));
  const content =
    block.kind === 'machine' ? (
      <MachineCard
        placementId={id}
        blockId={block.id}
        document={data.document}
        selected={!!selected}
        focusRequest={data.focusRequest}
        onFocused={data.onFocused}
        onEdit={data.onEdit}
        actions={data.machine}
        onManage={(view) => data.onManage(block.id, id, view)}
      >
        {resize}
      </MachineCard>
    ) : (
      <article
        className={`canvas-card ${block.origin} ${selected ? 'selected' : ''}${flipped ? ' flipped' : ''}`}
      >
        <Handle type="target" position={Position.Left} id="input" isConnectable={false} />
        <Handle type="source" position={Position.Right} id="output" isConnectable={false} />
        {!data.mobile && <FeedPort placementId={id} onFeed={data.machine.onFeed} />}
        {resize}
        <header className="card-grip">
          <span className="kind-mark">{block.origin === 'generated' ? '✳' : '◇'}</span>
          <span>{cardKind(block)}</span>
          <span className="card-status">
            {/* Develop's progress and recovery stay visible; starting it is in the menu. */}
            {!data.mobile && block.origin !== 'generated' && (activity.busy || activity.retry) && (
              <SpawnButton
                block={block}
                busy={activity.busy}
                phase={activity.phase}
                retry={activity.retry}
                onSpawn={() => data.onSpawn(block.id, id)}
              />
            )}
          </span>
          <button
            className={`nodrag nopan flip-button${changed ? ' changed' : ''}`}
            aria-pressed={flipped}
            aria-label={`${flipped ? 'Show front' : 'Show back'}${held ? ` · ${held} on the back` : ''}${changed ? ' · an input changed' : ''}`}
            title={flipped ? 'Show the front (F)' : 'Show the back (F)'}
            onClick={() => useInteraction.getState().flip(id)}
          >
            ↻{held > 0 && <span className="flip-count">{held}</span>}
          </button>
          {!data.mobile && (
            <ActionMenu
              label="Card actions"
              text="⋯"
              align="right"
              className="card-menu nodrag nopan"
            >
              {block.origin !== 'generated' && !activity.busy && !activity.retry && (
                <SpawnButton
                  block={block}
                  busy={false}
                  retry={false}
                  onSpawn={() => data.onSpawn(block.id, id)}
                />
              )}
              {block.messageId && (
                <button onClick={() => data.onContinue(block.messageId!)}>⑂ Continue</button>
              )}
              <button onClick={() => data.onContext(block.id)}>+ Use as context</button>
              <button onClick={() => data.onManage(block.id, id, 'place')}>
                Show on another brane…
              </button>
              <button onClick={() => data.onManage(block.id, id, 'versions')}>
                Version history
              </button>
              <button onClick={() => data.onManage(block.id, id, 'remove')}>
                Remove from this brane
              </button>
            </ActionMenu>
          )}
          <button
            className="nodrag nopan icon-button"
            title={data.mobile ? 'Open card in Focus' : 'Focus block'}
            onClick={() => data.onFocus(block.id)}
          >
            {data.mobile ? 'Open' : '↗'}
          </button>
        </header>
        {flipped ? (
          <CardBack placementId={id} blockId={block.id} document={data.document} actions={back} />
        ) : (
          <LiveBlockContent
            document={data.document}
            blockId={block.id}
            focusRequest={data.focusRequest}
            onFocused={data.onFocused}
            onEdit={data.onEdit}
            onStop={data.onStop}
            onRetry={data.onRetry}
          />
        )}
      </article>
    );
  return observer ? (
    <Profiler id={`card:${id}`} onRender={observer}>
      {content}
    </Profiler>
  ) : (
    content
  );
});
const nodeTypes = { card: Card, ask: AskBox };
interface Props extends ResponseActions {
  mobile: boolean;
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
  onInspect: CardData['onInspect'];
  onRerun: CardData['onRerun'];
  onDetach: CardData['onDetach'];
  machine: MachineActions;
  onReuse: CardData['onReuse'];
  ask?: AskRequest;
  asking: boolean;
  onAsk: (prompt: string) => void;
  onCancelAsk: () => void;
}
function Inner(props: Props) {
  const { mobile } = props;
  const { screenToFlowPosition, fitView, getViewport, setViewport } = useReactFlow();
  const fullScene = useStore(props.document.store, (s) => s.scene);
  // Only table placements are drawn; a placement on a back is shown by its host.
  const scene = useMemo(
    () =>
      fullScene.placements.some((p) => p.host_placement_id)
        ? { ...fullScene, placements: fullScene.placements.filter((p) => !p.host_placement_id) }
        : fullScene,
    [fullScene],
  );
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
  const addContext = useCallback((id: string) => props.onContext([id]), [props.onContext]);
  const setContinue = props.onContinue;
  // Read placements through a ref so moving cards never changes every card's callbacks.
  const latestPlacements = useRef(scene.placements);
  latestPlacements.current = scene.placements;
  const openSource = useCallback(
    (blockId: string) => {
      const placement = latestPlacements.current.find((p) => p.block_id === blockId);
      if (!placement) return;
      useInteraction.getState().setSelectedPlacements([placement.id]);
      void fitView({ nodes: [{ id: placement.id }], padding: 0.4, maxZoom: 1, duration: 200 });
    },
    [fitView],
  );
  const host = useRef<HTMLDivElement>(null);
  const placements = scene.placements;
  const {
    geometry,
    rectangle: rect,
    panning,
    bindings,
  } = useCanvasGesture(host, {
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
          mobile,
          blockId: p.block_id,
          document: props.document,
          resizable: selected.includes(p.id),
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
          onOpenSource: openSource,
          onInspect: props.onInspect,
          onRerun: props.onRerun,
          onDetach: props.onDetach,
          onReuse: props.onReuse,
          onStop: props.onStop,
          onRetry: props.onRetry,
          machine: props.machine,
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
    mobile,
    placements,
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
    openSource,
    props.onInspect,
    props.onRerun,
    props.onDetach,
    props.onReuse,
    props.onStop,
    props.onRetry,
    props.machine,
  ]);
  const askData = useMemo(
    () =>
      props.ask && {
        count: props.ask.references.length,
        busy: props.asking,
        onAsk: props.onAsk,
        onCancel: props.onCancelAsk,
      },
    [props.ask, props.asking, props.onAsk, props.onCancelAsk],
  );
  const allNodes = useMemo<(CardNode | AskNode)[]>(
    () =>
      props.ask && askData
        ? [
            ...nodes,
            {
              id: `ask:${props.ask.id}`,
              type: 'ask',
              position: { x: props.ask.x, y: props.ask.y },
              width: ASK_WIDTH,
              style: { width: ASK_WIDTH, pointerEvents: 'all' },
              data: askData,
            },
          ]
        : nodes,
    [nodes, props.ask, askData],
  );
  // An Ask box opened out of sight is brought into view with the cards it asks about.
  const askId = props.ask?.id;
  useEffect(() => {
    if (!askId) return;
    const frame = requestAnimationFrame(() => {
      const shown = allNodes.filter(
        (n) => n.id === `ask:${askId}` || (n.type === 'card' && selected.includes(n.id)),
      );
      if (!within(shown, host.current, getViewport()))
        void fitView({ nodes: shown, padding: 0.2, maxZoom: 1, duration: 0 });
    });
    return () => cancelAnimationFrame(frame);
    // Only a newly opened box moves the view.
  }, [askId]);
  // Machine runs and the feeds whose cards changed since the last run, as stable keys.
  const machineRuns = useStore(props.document.store, (s) =>
    (s.state?.runs ?? [])
      .filter((r) => r.machine_block_id)
      .map((r) => r.id)
      .join(' '),
  );
  useEffect(() => {
    if (!request || request.kind !== 'reveal') return;
    // A machine's output is framed with its machine; other outputs with their sources.
    const connections = derivationEdges(scene, new Set(machineRuns.split(' ').filter(Boolean)));
    // An output on a back is revealed by turning its host over.
    const hosts = fullScene.placements
      .filter((p) => p.block_id === request.blockId && p.host_placement_id)
      .map((p) => p.host_placement_id!);
    const output = [
      ...scene.placements.filter((p) => p.block_id === request.blockId).map((p) => p.id),
      ...hosts,
    ];
    for (const host of hosts) useInteraction.getState().flip(host, true);
    const ids = new Set([
      ...output,
      ...connections.filter((e) => output.includes(e.target)).map((e) => e.source),
    ]);
    const visible = nodes.filter((n) => ids.has(n.id));
    if (!visible.length) return;
    const frame = requestAnimationFrame(() => {
      if (presentation.getState().request?.id !== request.id) return;
      // Move the view only when part of what is revealed is outside it.
      if (!within(visible, host.current, getViewport()))
        void fitView({ nodes: visible, padding: 0.25, maxZoom: 1, duration: 0 });
      presentation.getState().consume(request.id);
    });
    return () => cancelAnimationFrame(frame);
  }, [
    request,
    fullScene.placements,
    scene.placements,
    scene.derivations,
    machineRuns,
    nodes,
    fitView,
    getViewport,
    presentation,
  ]);
  const changedFeeds = useStore(props.document.store, (s) => {
    const state = s.state;
    if (!state) return '';
    const machines = new Set(state.blocks.filter((b) => b.kind === 'machine').map((b) => b.id));
    return state.placements
      .filter((p) => machines.has(p.block_id))
      .flatMap((p) => {
        const view = machineStaleness(state, p.id);
        return view.ran ? view.changedFeeds : [];
      })
      .join(' ');
  });
  const edges = useMemo(
    () => [
      ...derivationEdges(scene, new Set(machineRuns.split(' ').filter(Boolean))),
      ...machineEdges(scene, new Set(changedFeeds.split(' ').filter(Boolean))),
    ],
    [scene, machineRuns, changedFeeds],
  );
  return (
    <div
      ref={host}
      tabIndex={0}
      aria-label="Artifact canvas"
      className={`canvas-host${panning ? ' panning' : ''}`}
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
        nodes={allNodes}
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
          className="selection-rectangle"
          style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
        />
      )}
    </div>
  );
}
// Whether every node lies inside the canvas at the current viewport.
function within(
  nodes: { position: { x: number; y: number }; width?: number; height?: number }[],
  host: HTMLElement | null,
  view: { x: number; y: number; zoom: number },
) {
  const bounds = host?.getBoundingClientRect();
  return (
    !!bounds &&
    nodes.every((n) => {
      const left = n.position.x * view.zoom + view.x,
        top = n.position.y * view.zoom + view.y;
      return (
        left >= 0 &&
        top >= 0 &&
        left + (n.width ?? 0) * view.zoom <= bounds.width &&
        top + (n.height ?? 0) * view.zoom <= bounds.height
      );
    })
  );
}
export const BraneCanvas = memo(function BraneCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
});
