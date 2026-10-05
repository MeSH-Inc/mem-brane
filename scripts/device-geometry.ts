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

export function isolatedCaseUrls(value: string | undefined): string[] {
  if (!value)
    throw new Error(
      'Set STRESS_DEVICE_CASE_URLS to two fresh localhost fixture URLs, one per save delay',
    );
  const values: unknown = JSON.parse(value);
  if (
    !Array.isArray(values) ||
    values.length !== 2 ||
    !values.every((v) => typeof v === 'string')
  ) {
    throw new Error('Two fixture URLs are required');
  }
  const urls = values.map((v) => new URL(v));
  if (
    urls.some(
      (u) =>
        u.protocol !== 'http:' ||
        !['localhost', '127.0.0.1'].includes(u.hostname) ||
        u.username ||
        u.password ||
        u.pathname !== '/e2e/stress/index.html',
    ) ||
    urls[0].origin === urls[1].origin
  ) {
    throw new Error('Each save delay requires a distinct dedicated localhost origin');
  }
  return urls.map((u) => u.href);
}

export function visiblePinch(editor: Rect, canvas: Rect, viewport: Rect) {
  // Reuse the strict intersection check; there must be a meaningful visible editor.
  const visible = visibleEditorSwipe([editor, canvas, viewport]);
  const left = Math.max(editor.x, canvas.x, viewport.x);
  const right = Math.min(
    editor.x + editor.width,
    canvas.x + canvas.width,
    viewport.x + viewport.width,
  );
  const x1 = Math.max(canvas.x, viewport.x) + 15;
  const x2 = left + 24;
  const y = (visible.from.y + visible.to.y) / 2;
  if (x2 - x1 < 30 || x2 + 70 > right - 12) throw new Error('Insufficient visible pinch travel');
  return { first: { id: 1, x: x1, y }, second: { id: 2, x: x2, y }, end: { id: 2, x: x2 + 70, y } };
}
