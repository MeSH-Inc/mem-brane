import { expect, it, vi } from 'vitest';
import {
  CanvasGestures,
  idlePreview,
  type GesturePreview,
  type Press,
  type Viewport,
} from '../src/canvas/gestures';
import type { Placement } from '../shared/types/domain';
function fixture() {
  let placements: Placement[] = ['a', 'b'].map((id, i) => ({
    id,
    block_id: id,
    brane_id: 'brane',
    x: 100 + i * 400,
    y: 100,
    width: 300,
    height: 220,
    version: 0,
    z_index: 0,
  }));
  let selection = ['b'],
    view: Viewport = { x: 0, y: 0, zoom: 1 },
    preview: GesturePreview = idlePreview;
  const create = vi.fn(),
    commit = vi.fn();
  const gestures = new CanvasGestures({
    placements: () => placements,
    selection: () => selection,
    select: (ids) => {
      selection = ids;
    },
    viewport: () => view,
    camera: (next) => {
      view = next;
    },
    preview: (next) => {
      preview = next;
    },
    create,
    commit,
  });
  return {
    gestures,
    create,
    commit,
    get selection() {
      return selection;
    },
    get preview() {
      return preview;
    },
    get view() {
      return view;
    },
    update: (p: Placement[]) => {
      placements = p;
    },
    get placements() {
      return placements;
    },
  };
}
const press = (surface: Press['surface'], point = { x: 100, y: 100 }): Press => ({
  surface,
  point,
  pointerId: 1,
  button: 0,
  touch: false,
  shift: false,
});
it.each([0, 1, 4, 7])(
  'treats %i pixels of header movement as a click without persisting geometry',
  (delta) => {
    const f = fixture();
    f.gestures.begin(press({ kind: 'card', id: 'a' }), 'select');
    f.gestures.end(1, { x: 100 + delta, y: 100 });
    expect(f.selection).toEqual(['a']);
    expect(f.commit).not.toHaveBeenCalled();
  },
);
it('moves a selected group using the full delta and commits each member once', () => {
  const f = fixture();
  f.gestures.begin({ ...press({ kind: 'card', id: 'a' }), shift: true }, 'select');
  f.gestures.end(1, { x: 100, y: 100 });
  f.gestures.begin(press({ kind: 'card', id: 'a' }), 'select');
  f.gestures.move(1, { x: 150, y: 125 });
  expect(f.commit).not.toHaveBeenCalled();
  expect(f.preview.geometry.b.x).toBe(550);
  f.gestures.end(1, { x: 160, y: 130 });
  expect(f.commit).toHaveBeenCalledTimes(2);
  expect(f.commit).toHaveBeenCalledWith('a', { x: 160, y: 130, width: 300, height: 220 });
});
for (const kind of ['select', 'write', 'pan', 'move', 'resize'] as const) {
  it(`cancels ${kind} without committing and accepts a fresh gesture`, () => {
    const f = fixture();
    const surface: Press['surface'] =
      kind === 'move'
        ? { kind: 'card', id: 'a' }
        : kind === 'resize'
          ? { kind: 'resize', id: 'a', edge: 'se' }
          : { kind: 'background' };
    f.gestures.begin(
      press(surface, { x: 80, y: 80 }),
      kind === 'move' || kind === 'resize' ? 'select' : kind,
    );
    f.gestures.move(1, { x: 150, y: 150 });
    f.gestures.cancel();
    f.gestures.end(1, { x: 150, y: 150 });
    expect(f.selection).toEqual(['b']);
    expect(f.preview).toBe(idlePreview);
    expect(f.view).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
    f.gestures.begin(press({ kind: 'card', id: 'a' }), 'select');
    f.gestures.end(1, { x: 100, y: 100 });
    expect(f.selection).toEqual(['a']);
  });
}
it('creates on a Write click and on a reverse drag with minimum dimensions', () => {
  const f = fixture();
  f.gestures.begin(press({ kind: 'background' }), 'write');
  f.gestures.end(1, { x: 101, y: 100 });
  expect(f.create).toHaveBeenLastCalledWith({ x: 100, y: 100, width: 320, height: 220 });
  f.gestures.begin(press({ kind: 'background' }), 'write');
  f.gestures.end(1, { x: 80, y: 60 });
  expect(f.create).toHaveBeenLastCalledWith({ x: 80, y: 60, width: 220, height: 160 });
});
it('keeps a resize preview through incoming content/geometry and skips removed placements', () => {
  const f = fixture();
  f.gestures.begin(press({ kind: 'resize', id: 'a', edge: 'nw' }), 'select');
  f.gestures.move(1, { x: 140, y: 130 });
  const before = f.preview.geometry.a;
  f.update(f.placements.map((p) => ({ ...p, x: 999, version: 1 })));
  expect(f.preview.geometry.a).toEqual(before);
  f.update([]);
  f.gestures.end(1, { x: 140, y: 130 });
  expect(f.commit).not.toHaveBeenCalled();
});
it('transitions from touch pan to pinch and back without creating, selecting or moving cards', () => {
  const f = fixture();
  f.gestures.begin({ ...press({ kind: 'background' }), touch: true }, 'write');
  f.gestures.begin(
    { ...press({ kind: 'background' }, { x: 200, y: 100 }), pointerId: 2, touch: true },
    'write',
  );
  f.gestures.move(2, { x: 250, y: 100 });
  expect(f.view.zoom).toBe(1.5);
  f.gestures.end(2, { x: 250, y: 100 });
  f.gestures.move(1, { x: 120, y: 100 });
  f.gestures.end(1, { x: 120, y: 100 });
  expect(f.gestures.active).toBe(false);
  expect(f.selection).toEqual(['b']);
  expect(f.commit).not.toHaveBeenCalled();
  expect(f.create).not.toHaveBeenCalled();
});
