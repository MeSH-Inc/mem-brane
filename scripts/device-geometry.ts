export type Rect = { x: number; y: number; width: number; height: number };

// Rectangles are in CSS pixels. Fail rather than inject into an occluding control.
export function visibleEditorSwipe(rectangles: Rect[]) {
  if (
    !rectangles.length ||
    rectangles.some(
      (r) => ![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0,
    )
  ) {
    throw new Error('Invalid editor clipping geometry');
  }
  const left = Math.max(...rectangles.map((r) => r.x));
  const right = Math.min(...rectangles.map((r) => r.x + r.width));
  const top = Math.max(...rectangles.map((r) => r.y));
  const bottom = Math.min(...rectangles.map((r) => r.y + r.height));
  const inset = 12;
  if (right - left < 2 * inset || bottom - top < 2 * inset + 40) {
    throw new Error('Insufficient visible editor area for a meaningful swipe');
  }
  const x = (left + right) / 2;
  return { from: { x, y: bottom - inset }, to: { x, y: top + inset } };
}
