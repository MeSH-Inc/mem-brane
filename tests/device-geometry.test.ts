import { describe, expect, it } from 'vitest';
import { visibleEditorSwipe } from '../scripts/device-geometry';

describe('physical Android editor swipe', () => {
  it('keeps the POCO regression path above the clipped canvas bottom', () => {
    const { from, to } = visibleEditorSwipe([
      { x: 80.73, y: 390.36, width: 318.55, height: 197.82 },
      { x: 0, y: 268.91, width: 392.73, height: 284.73 },
      { x: 0, y: 0, width: 392, height: 714 },
    ]);
    expect(from.y).toBeCloseTo(541.64);
    expect(to.y).toBeCloseTo(402.36);
    expect(from.x).toBeLessThan(392);
    expect(from.y - to.y).toBeGreaterThan(30);
  });
  it('honors offset visual viewport and nested clipping', () => {
    const { from, to } = visibleEditorSwipe([
      { x: 10, y: 10, width: 300, height: 600 },
      { x: 50, y: 200, width: 200, height: 180 },
      { x: 0, y: 250, width: 390, height: 400 },
    ]);
    expect(from).toEqual({ x: 150, y: 368 });
    expect(to).toEqual({ x: 150, y: 262 });
  });
  it('rejects hidden, too-small and nonfinite targets instead of relaxing assertions', () => {
    for (const rectangles of [
      [],
      [{ x: 0, y: 0, width: 100, height: 40 }],
      [
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 0, y: 200, width: 100, height: 100 },
      ],
      [{ x: NaN, y: 0, width: 100, height: 100 }],
    ]) {
      expect(() => visibleEditorSwipe(rectangles)).toThrow();
    }
  });
});
