// Bound aggregate workspace responses: 200 placements × 20,000 text characters.
// These domain limits apply equally to HTTP, ingestion and generated artifacts.
export const MAX_BRANE_PLACEMENTS = 200;
export const MAX_BLOCK_TEXT_CHARACTERS = 20000;
export const MAX_BLOCK_CONTENT_BYTES = 32768;
// The most cards one run reads. What they may hold together is bounded separately by the
// context allowance; this bound keeps one request's list of cards small.
export const MAX_RUN_INPUTS = 64;
const encoder = new TextEncoder();
export function fitsArtifactContent<T extends { text: string }>(content: T): boolean {
  return (
    content.text.length <= MAX_BLOCK_TEXT_CHARACTERS &&
    encoder.encode(JSON.stringify(content)).byteLength <= MAX_BLOCK_CONTENT_BYTES
  );
}
