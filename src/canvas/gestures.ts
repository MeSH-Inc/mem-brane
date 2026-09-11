import type { Geometry, Placement } from '../../shared/types/domain';
import type { CanvasTool } from './tools';
export type Point = { x: number; y: number };
export type Viewport = Point & { zoom: number };
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export type Surface =
  | { kind: 'background' }
  | { kind: 'card'; id: string }
  | { kind: 'resize'; id: string; edge: ResizeEdge };
export interface Press {
  pointerId: number;
  point: Point;
  surface: Surface;
  button: number;
  touch: boolean;
  shift: boolean;
}
export interface GesturePreview {
  geometry: Record<string, Geometry>;
  rectangle?: Geometry & { kind: 'write' | 'select' };
}
export const idlePreview: GesturePreview = { geometry: {} };
export const CLICK_DISTANCE = 8;
export const defaultViewport: Viewport = { x: 20, y: 20, zoom: 1 };
export const clampZoom = (zoom: number) => Math.max(0.2, Math.min(2, zoom));
export const worldPoint = (point: Point, view: Viewport): Point => ({
  x: (point.x - view.x) / view.zoom,
  y: (point.y - view.y) / view.zoom,
});
const rectangle = (a: Point, b: Point): Geometry => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(a.x - b.x),
  height: Math.abs(a.y - b.y),
});
const intersects = (a: Geometry, b: Geometry) =>
  a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
export interface GestureOwner {
  placements(): Placement[];
  selection(): string[];
  select(ids: string[]): void;
  viewport(): Viewport;
  camera(view: Viewport): void;
  preview(value: GesturePreview): void;
  create(geometry: Geometry): void;
  commit(id: string, geometry: Geometry): void;
}
type Gesture = Press & {
  kind: 'write' | 'select' | 'pan' | 'move' | 'resize';
  moved: boolean;
  view: Viewport;
  selection: string[];
  placements: Placement[];
};
// The application owns recognition, preview, commit and cancellation. Rendering
// libraries never interpret a pointer or turn a preview into a durable mutation.
export class CanvasGestures {
  private gesture?: Gesture;
  private touches = new Map<number, Point>();
  private pinch?: { view: Viewport; anchor: Point; distance: number };
  private preview: GesturePreview = idlePreview;
  constructor(private owner: GestureOwner) {}
  get active() {
    return !!this.gesture || !!this.pinch;
  }
  get pointerIds() {
    return this.touches.size
      ? [...this.touches.keys()]
      : this.gesture
        ? [this.gesture.pointerId]
        : [];
  }
  private show(preview: GesturePreview) {
    this.preview = preview;
    this.owner.preview(preview);
  }
  begin(press: Press, tool: CanvasTool): boolean {
    if (press.button > 2 || (this.active && (!press.touch || this.gesture?.touch === false)))
      return false;
    if (press.touch) {
      this.touches.set(press.pointerId, press.point);
      if (this.touches.size >= 2) {
        if (this.touches.size > 2) return true;
        const [a, b] = [...this.touches.values()];
        const view = this.owner.viewport();
        if (this.gesture?.kind === 'select') this.owner.select(this.gesture.selection);
        this.gesture = undefined;
        this.show(idlePreview);
        this.pinch = {
          view,
          anchor: worldPoint({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view),
          distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
        };
        return true;
      }
    }
    const surface = press.surface;
    const kind =
      press.button !== 0 || press.touch || tool === 'pan'
        ? 'pan'
        : surface.kind === 'resize'
          ? 'resize'
          : surface.kind === 'card'
            ? 'move'
            : tool;
    this.gesture = {
      ...press,
      kind,
      moved: false,
      view: this.owner.viewport(),
      selection: [...this.owner.selection()],
      placements: this.owner.placements().map((p) => ({ ...p })),
    };
    return true;
  }
  move(pointerId: number, point: Point) {
    if (this.touches.has(pointerId)) this.touches.set(pointerId, point);
    if (this.pinch) {
      const [a, b] = [...this.touches.values()];
      if (!a || !b) return;
      const zoom = clampZoom(
        (this.pinch.view.zoom * Math.hypot(b.x - a.x, b.y - a.y)) / this.pinch.distance,
      );
      this.owner.camera({
        x: (a.x + b.x) / 2 - this.pinch.anchor.x * zoom,
        y: (a.y + b.y) / 2 - this.pinch.anchor.y * zoom,
        zoom,
      });
      return;
    }
    const g = this.gesture;
    if (!g || g.pointerId !== pointerId) return;
    const dx = point.x - g.point.x,
      dy = point.y - g.point.y;
    if (!g.moved && Math.hypot(dx, dy) < CLICK_DISTANCE) return;
    g.moved = true;
    if (g.kind === 'pan') {
      this.owner.camera({ ...g.view, x: g.view.x + dx, y: g.view.y + dy });
      return;
    }
    if (g.kind === 'select' || g.kind === 'write') {
      const bounds = rectangle(worldPoint(g.point, g.view), worldPoint(point, g.view));
      if (g.kind === 'select')
        this.owner.select(g.placements.filter((p) => intersects(bounds, p)).map((p) => p.id));
      this.show({ geometry: {}, rectangle: { ...rectangle(g.point, point), kind: g.kind } });
      return;
    }
    if (g.surface.kind === 'background') return;
    const id = g.surface.id;
    const ids = g.selection.includes(id) ? g.selection : g.shift ? [...g.selection, id] : [id];
    this.owner.select(g.kind === 'resize' ? [id] : ids);
    const geometry: Record<string, Geometry> = {};
    for (const p of g.placements) {
      if (g.kind === 'move' && ids.includes(p.id))
        geometry[p.id] = {
          x: p.x + dx / g.view.zoom,
          y: p.y + dy / g.view.zoom,
          width: p.width,
          height: p.height,
        };
      else if (g.surface.kind === 'resize' && p.id === id) {
        const edge = g.surface.edge;
        const width = Math.max(
          180,
          p.width + (edge.includes('e') ? dx : edge.includes('w') ? -dx : 0) / g.view.zoom,
        );
        const height = Math.max(
          120,
          p.height + (edge.includes('s') ? dy : edge.includes('n') ? -dy : 0) / g.view.zoom,
        );
        geometry[p.id] = {
          x: p.x + (edge.includes('w') ? p.width - width : 0),
          y: p.y + (edge.includes('n') ? p.height - height : 0),
          width,
          height,
        };
      }
    }
    this.show({ geometry });
  }
  end(pointerId: number, point: Point) {
    this.move(pointerId, point);
    this.touches.delete(pointerId);
    if (this.pinch) {
      if (this.touches.size < 2) {
        this.pinch = undefined;
        const remaining = this.touches.entries().next().value;
        if (remaining) {
          this.begin(
            {
              pointerId: remaining[0],
              point: remaining[1],
              surface: { kind: 'background' },
              button: 0,
              touch: true,
              shift: false,
            },
            'pan',
          );
          this.gesture!.moved = true;
        }
      }
      return;
    }
    const g = this.gesture;
    if (!g || g.pointerId !== pointerId) return;
    this.gesture = undefined;
    const preview = this.preview;
    this.show(idlePreview);
    if (g.kind === 'write') {
      const bounds = rectangle(worldPoint(g.point, g.view), worldPoint(point, g.view));
      this.owner.create(
        g.moved
          ? { ...bounds, width: Math.max(220, bounds.width), height: Math.max(160, bounds.height) }
          : { ...worldPoint(g.point, g.view), width: 320, height: 220 },
      );
    } else if (g.moved && (g.kind === 'move' || g.kind === 'resize')) {
      const existing = new Set(this.owner.placements().map((p) => p.id));
      for (const [id, geometry] of Object.entries(preview.geometry)) {
        const before = g.placements.find((p) => p.id === id)!;
        if (
          existing.has(id) &&
          (['x', 'y', 'width', 'height'] as const).some((key) => before[key] !== geometry[key])
        )
          this.owner.commit(id, geometry);
      }
    } else if (!g.moved && !g.touch && g.button === 0) {
      if (g.surface.kind === 'background') this.owner.select([]);
      else if (g.kind === 'move') {
        const id = g.surface.id;
        this.owner.select(
          g.shift
            ? g.selection.includes(id)
              ? g.selection.filter((p) => p !== id)
              : [...g.selection, id]
            : [id],
        );
      }
    }
  }
  cancel() {
    const g = this.gesture,
      pinch = this.pinch;
    this.gesture = undefined;
    this.pinch = undefined;
    this.touches.clear();
    if (g) {
      const existing = new Set(this.owner.placements().map((p) => p.id));
      this.owner.select(g.selection.filter((id) => existing.has(id)));
      if (g.kind === 'pan') this.owner.camera(g.view);
    } else if (pinch) this.owner.camera(pinch.view);
    this.show(idlePreview);
  }
}
