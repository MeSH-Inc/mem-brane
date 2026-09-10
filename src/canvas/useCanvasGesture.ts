import {
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  CanvasGestures,
  clampZoom,
  idlePreview,
  worldPoint,
  type GestureOwner,
  type ResizeEdge,
  type Surface,
} from './gestures';
import type { CanvasTool } from './tools';
// Native editors and controls retain their browser gestures in every tool.
const nativeSurface =
  'button, input, textarea, select, a, summary, [contenteditable], [data-canvas-native], .response-content, .image-content, .pdf-content, .react-flow__controls';
export function useCanvasGesture(
  tool: CanvasTool,
  host: RefObject<HTMLDivElement | null>,
  owner: Omit<GestureOwner, 'preview'>,
) {
  const callbacks = useRef(owner);
  callbacks.current = owner;
  const [preview, setPreview] = useState(idlePreview);
  const [gestures] = useState(
    () =>
      new CanvasGestures({
        placements: () => callbacks.current.placements(),
        selection: () => callbacks.current.selection(),
        select: (ids) => callbacks.current.select(ids),
        viewport: () => callbacks.current.viewport(),
        camera: (view) => callbacks.current.camera(view),
        create: (g) => callbacks.current.create(g),
        commit: (id, g) => callbacks.current.commit(id, g),
        preview: setPreview,
      }),
  );
  const cancel = () => {
    const pointers = gestures.pointerIds;
    gestures.cancel();
    for (const id of pointers)
      if (host.current?.hasPointerCapture(id)) host.current.releasePointerCapture(id);
  };
  useLayoutEffect(cancel, [tool]);
  useLayoutEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && gestures.active) {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    };
    const blur = () => cancel();
    const wheel = (event: WheelEvent) => {
      if (!(event.target instanceof Element) || event.target.closest(nativeSurface)) return;
      event.preventDefault();
      if (gestures.active) return;
      const view = callbacks.current.viewport();
      const unit =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? host.current!.clientHeight : 1;
      if (event.ctrlKey || event.metaKey) {
        const bounds = host.current!.getBoundingClientRect();
        const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
        const anchor = worldPoint(point, view);
        const zoom = clampZoom(view.zoom * Math.exp(-event.deltaY * unit * 0.01));
        callbacks.current.camera({
          x: point.x - anchor.x * zoom,
          y: point.y - anchor.y * zoom,
          zoom,
        });
      } else
        callbacks.current.camera({
          ...view,
          x: view.x - event.deltaX * unit,
          y: view.y - event.deltaY * unit,
        });
    };
    const element = host.current;
    window.addEventListener('keydown', escape, true);
    window.addEventListener('blur', blur);
    element?.addEventListener('wheel', wheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', blur);
      element?.removeEventListener('wheel', wheel);
      cancel();
    };
  }, [gestures]);
  const point = (event: ReactPointerEvent) => {
    const bounds = host.current!.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };
  return {
    ...preview,
    bindings: {
      onPointerDownCapture(event: ReactPointerEvent<HTMLDivElement>) {
        if (!(event.target instanceof Element) || event.target.closest(nativeSurface)) return;
        const node = event.target.closest<HTMLElement>('.react-flow__node');
        const edge = event.target.closest<HTMLElement>('[data-resize]')?.dataset.resize as
          ResizeEdge | undefined;
        const surface: Surface = node?.dataset.id
          ? edge
            ? { kind: 'resize', id: node.dataset.id, edge }
            : { kind: 'card', id: node.dataset.id }
          : { kind: 'background' };
        if (
          !gestures.begin(
            {
              pointerId: event.pointerId,
              point: point(event),
              surface,
              button: event.button,
              touch: event.pointerType === 'touch',
              shift: event.shiftKey,
            },
            tool,
          )
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        (node ?? event.currentTarget).focus({ preventScroll: true });
      },
      onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
        gestures.move(event.pointerId, point(event));
      },
      onPointerUpCapture(event: ReactPointerEvent<HTMLDivElement>) {
        if (!gestures.pointerIds.includes(event.pointerId)) return;
        gestures.end(event.pointerId, point(event));
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
        event.stopPropagation();
      },
      onPointerCancelCapture(event: ReactPointerEvent<HTMLDivElement>) {
        if (gestures.pointerIds.includes(event.pointerId)) cancel();
      },
      onLostPointerCapture(event: ReactPointerEvent<HTMLDivElement>) {
        if (gestures.pointerIds.includes(event.pointerId)) cancel();
      },
      onContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
        if (event.target instanceof Element && !event.target.closest(nativeSurface))
          event.preventDefault();
      },
      onKeyDownCapture(event: ReactKeyboardEvent<HTMLDivElement>) {
        if (
          !(event.target instanceof Element) ||
          event.target.closest(nativeSurface) ||
          gestures.active
        )
          return;
        const id = event.target.closest<HTMLElement>('.react-flow__node')?.dataset.id;
        if (event.key === 'Escape') callbacks.current.select([]);
        else if ((event.key === ' ' || event.key === 'Enter') && id)
          callbacks.current.select(
            event.shiftKey ? [...new Set([...callbacks.current.selection(), id])] : [id],
          );
        else if (
          tool !== 'pan' &&
          ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
        ) {
          const amount = event.shiftKey ? 20 : 5;
          const dx = event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0;
          const dy = event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0;
          const selected = new Set(callbacks.current.selection());
          for (const p of callbacks.current.placements())
            if (selected.has(p.id))
              callbacks.current.commit(p.id, {
                x: p.x + dx,
                y: p.y + dy,
                width: p.width,
                height: p.height,
              });
        } else return;
        event.preventDefault();
        event.stopPropagation();
      },
    },
  };
}
