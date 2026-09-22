import { expect, it, vi } from 'vitest';
import {
  CanvasGestures,
  idlePreview,
  type GesturePreview,
  type Press,
  type Viewport,
} from '../src/canvas/gestures';
import type { Placement } from '../shared/types/domain';
function fixture(clock = { now: 0 }) {
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
  const gestures = new CanvasGestures(
    {
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
    },
    () => clock.now,
  );
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
    f.gestures.begin(press({ kind: 'card', id: 'a' }));
    f.gestures.end(1, { x: 100 + delta, y: 100 });
    expect(f.selection).toEqual(['a']);
    expect(f.commit).not.toHaveBeenCalled();
  },
);
it('moves a selected group using the full delta and commits each member once', () => {
  const f = fixture();
  f.gestures.begin({ ...press({ kind: 'card', id: 'a' }), shift: true });
  f.gestures.end(1, { x: 100, y: 100 });
  f.gestures.begin(press({ kind: 'card', id: 'a' }));
  f.gestures.move(1, { x: 150, y: 125 });
  expect(f.commit).not.toHaveBeenCalled();
  expect(f.preview.geometry.b.x).toBe(550);
  f.gestures.end(1, { x: 160, y: 130 });
  expect(f.commit).toHaveBeenCalledTimes(2);
  expect(f.commit).toHaveBeenCalledWith('a', { x: 160, y: 130, width: 300, height: 220 });
});
for (const kind of ['select', 'pan', 'move', 'resize'] as const) {
  it(`cancels ${kind} without committing and accepts a fresh gesture`, () => {
    const f = fixture();
    const surface: Press['surface'] =
      kind === 'move'
        ? { kind: 'card', id: 'a' }
        : kind === 'resize'
          ? { kind: 'resize', id: 'a', edge: 'se' }
          : { kind: 'background' };
    f.gestures.begin({ ...press(surface, { x: 80, y: 80 }), pan: kind === 'pan' });
    f.gestures.move(1, { x: 150, y: 150 });
    f.gestures.cancel();
    f.gestures.end(1, { x: 150, y: 150 });
    expect(f.selection).toEqual(['b']);
    expect(f.preview).toBe(idlePreview);
    expect(f.view).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
    f.gestures.begin(press({ kind: 'card', id: 'a' }));
    f.gestures.end(1, { x: 100, y: 100 });
    expect(f.selection).toEqual(['a']);
  });
}
it('creates on a background double-click but not on slow, distant or dragged clicks', () => {
  const clock = { now: 0 };
  const f = fixture(clock);
  const click = (point = { x: 100, y: 100 }, end = point) => {
    f.gestures.begin(press({ kind: 'background' }, point));
    f.gestures.end(1, end);
  };
  click();
  clock.now = 500;
  click();
  expect(f.create).not.toHaveBeenCalled();
  clock.now = 600;
  click({ x: 140, y: 100 });
  expect(f.create).not.toHaveBeenCalled();
  clock.now = 700;
  click({ x: 140, y: 100 }, { x: 180, y: 140 });
  expect(f.create).not.toHaveBeenCalled();
  // The drag became a marquee over card a rather than a click.
  expect(f.selection).toEqual(['a']);
  clock.now = 800;
  click();
  clock.now = 1000;
  click({ x: 102, y: 101 });
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.create).toHaveBeenLastCalledWith({ x: 102, y: 101, width: 320, height: 220 });
  clock.now = 1100;
  click({ x: 102, y: 101 });
  expect(f.create).toHaveBeenCalledOnce();
});
it('pans from a card or background while the pan modifier is held, without moving cards', () => {
  const f = fixture();
  f.gestures.begin({ ...press({ kind: 'card', id: 'a' }), pan: true });
  f.gestures.move(1, { x: 160, y: 130 });
  f.gestures.end(1, { x: 160, y: 130 });
  expect(f.view).toEqual({ x: 60, y: 30, zoom: 1 });
  expect(f.commit).not.toHaveBeenCalled();
  expect(f.selection).toEqual(['b']);
});
it('keeps a resize preview through incoming content/geometry and skips removed placements', () => {
  const f = fixture();
  f.gestures.begin(press({ kind: 'resize', id: 'a', edge: 'nw' }));
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
  f.gestures.begin({ ...press({ kind: 'background' }), touch: true });
  f.gestures.begin({
    ...press({ kind: 'background' }, { x: 200, y: 100 }),
    pointerId: 2,
    touch: true,
  });
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

it('retains the current gesture owner when a different input device presses', () => {
  const f = fixture();
  f.gestures.begin(press({ kind: 'card', id: 'a' }));
  f.gestures.move(1, { x: 140, y: 120 });
  expect(f.gestures.begin({ ...press({ kind: 'background' }), pointerId: 2, touch: true })).toBe(
    false,
  );
  f.gestures.end(1, { x: 150, y: 120 });
  expect(f.commit).toHaveBeenCalledOnce();
  expect(f.commit).toHaveBeenCalledWith('a', { x: 150, y: 120, width: 300, height: 220 });
});
