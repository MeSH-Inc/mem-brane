// Slide right from the preferred point until a new card would overlap no placement,
// so a new machine never lands on the cards it is meant to be fed from.
export function openSpot(
  placements: { x: number; y: number; width: number; height: number }[],
  point: { x: number; y: number },
  width: number,
  height: number,
) {
  const gap = 40;
  let x = point.x;
  for (let attempt = 0; attempt < 200; attempt++) {
    const blocker = placements.find(
      (p) =>
        x < p.x + p.width + gap &&
        x + width + gap > p.x &&
        point.y < p.y + p.height + gap &&
        point.y + height + gap > p.y,
    );
    if (!blocker) break;
    x = blocker.x + blocker.width + gap;
  }
  return { x, y: point.y, width, height };
}
