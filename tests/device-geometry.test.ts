import { describe, expect, it } from 'vitest';
import { visibleEditorSwipe, visiblePinch, isolatedCaseUrls } from '../scripts/device-geometry';

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

describe('isolated physical device cases', () => {
  it('rejects shared origins even if URL query or hostname path differs', () => {
    const a = 'http://127.0.0.1:48001/e2e/stress/index.html?view=canvas';
    expect(() => isolatedCaseUrls(JSON.stringify([a, a + '&case=2']))).toThrow();
    expect(() => isolatedCaseUrls(undefined)).toThrow();
    expect(() => isolatedCaseUrls(JSON.stringify([a]))).toThrow();
    expect(() =>
      isolatedCaseUrls(JSON.stringify([a, 'https://example.com/e2e/stress/index.html'])),
    ).toThrow();
    expect(isolatedCaseUrls(JSON.stringify([a, a.replace('48001', '48002')]))).toHaveLength(2);
  });
  it('keeps both pinch contacts and the outward travel within the clipped editor/viewport', () => {
    const p = visiblePinch(
      { x: 120, y: 390, width: 318, height: 198 },
      { x: 0, y: 269, width: 392, height: 285 },
      { x: 0, y: 0, width: 392, height: 714 },
    );
    expect(p.first.x).toBe(15);
    expect(p.second.x).toBe(144);
    expect(p.end.x).toBe(214);
    expect(p.second.y).toBeGreaterThan(390);
    expect(p.second.y).toBeLessThan(554);
    expect(() =>
      visiblePinch(
        { x: 340, y: 390, width: 100, height: 198 },
        { x: 0, y: 269, width: 392, height: 285 },
        { x: 0, y: 0, width: 392, height: 714 },
      ),
    ).toThrow();
  });
});
