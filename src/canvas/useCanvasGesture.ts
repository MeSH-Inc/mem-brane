import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { CanvasTool } from './toolPolicy';
import { useInteraction } from '../stores/interaction';

type Point = { x: number; y: number };
type Rectangle = Point & { width: number; height: number };
type Gesture = {
  tool: 'write' | 'select';
  pointerId: number;
  target: HTMLElement;
  start: Point;
  local: Point;
  selection: string[];
};

// React Flow owns marquee geometry. This hook owns the lifetime of empty-pane
// gestures, and the custom Write rectangle. Each pointer has exactly one owner.
export function useCanvasGesture(
  tool: CanvasTool,
  screenToFlowPosition: (point: Point) => Point,
  onCreate: (rectangle: Rectangle) => void,
  resetMarquee: () => void,
) {
  const active = useRef<Gesture | null>(null);
  const [rect, setRect] = useState<Rectangle | null>(null);
  const callbacks = useRef({ screenToFlowPosition, onCreate, resetMarquee });
  callbacks.current = { screenToFlowPosition, onCreate, resetMarquee };
  const release = (g: Gesture) => {
    if (g.target.hasPointerCapture(g.pointerId)) g.target.releasePointerCapture(g.pointerId);
  };
  const cancel = useCallback((unmount = false) => {
    const g = active.current;
    if (!g) return;
    active.current = null;
    release(g);
    if (g.tool === 'select') {
      useInteraction.getState().setSelectedPlacements(g.selection);
      if (!unmount) callbacks.current.resetMarquee();
    }
    if (!unmount) setRect(null);
  }, []);
  useLayoutEffect(() => {
    cancel();
  }, [tool, cancel]);
  useLayoutEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && active.current) {
        event.preventDefault();
        cancel();
      }
    };
    const blur = () => cancel();
    window.addEventListener('keydown', escape, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', blur);
      cancel(true);
    };
  }, [cancel]);
  return {
    rect,
    bindings: {
      onPointerDownCapture(event: ReactPointerEvent<HTMLDivElement>) {
        if (
          active.current ||
          tool === 'pan' ||
          event.button !== 0 ||
          !event.isPrimary ||
          event.pointerType === 'touch' ||
          !(event.target instanceof HTMLElement) ||
          !event.target.classList.contains('react-flow__pane')
        )
          return;
        const bounds = event.currentTarget.getBoundingClientRect();
        const target = tool === 'write' ? event.currentTarget : event.target;
        active.current = {
          tool,
          pointerId: event.pointerId,
          target,
          start: { x: event.clientX, y: event.clientY },
          local: { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
          selection: useInteraction.getState().selectedPlacements,
        };
        if (tool === 'write') {
          target.setPointerCapture(event.pointerId);
          event.preventDefault();
          event.stopPropagation();
        }
      },
      onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
        const g = active.current;
        if (!g || g.tool !== 'write' || g.pointerId !== event.pointerId) return;
        const dx = event.clientX - g.start.x,
          dy = event.clientY - g.start.y;
        setRect({
          x: g.local.x + Math.min(0, dx),
          y: g.local.y + Math.min(0, dy),
          width: Math.abs(dx),
          height: Math.abs(dy),
        });
      },
      onPointerUpCapture(event: ReactPointerEvent<HTMLDivElement>) {
        const g = active.current;
        if (!g || g.pointerId !== event.pointerId) return;
        // Clear before React Flow releases capture: normal completion is not cancellation.
        active.current = null;
        if (g.tool === 'select') return;
        release(g);
        setRect(null);
        if (Math.hypot(event.clientX - g.start.x, event.clientY - g.start.y) < 8) return;
        const convert = callbacks.current.screenToFlowPosition;
        const a = convert({
          x: Math.min(g.start.x, event.clientX),
          y: Math.min(g.start.y, event.clientY),
        });
        const b = convert({
          x: Math.max(g.start.x, event.clientX),
          y: Math.max(g.start.y, event.clientY),
        });
        callbacks.current.onCreate({
          ...a,
          width: Math.max(220, b.x - a.x),
          height: Math.max(160, b.y - a.y),
        });
      },
      onPointerCancelCapture(event: ReactPointerEvent<HTMLDivElement>) {
        if (active.current?.pointerId === event.pointerId) cancel();
      },
      onLostPointerCapture(event: ReactPointerEvent<HTMLDivElement>) {
        if (active.current?.pointerId === event.pointerId) cancel();
      },
    },
  };
}
