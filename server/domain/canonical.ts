import { createHash } from 'node:crypto';
export function canonicalJson(value: unknown): string {
  const sort = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sort)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, item]) => [key, sort(item)]),
          )
        : value;
  return JSON.stringify(sort(value));
}
export function representationId(asset: string, format: string, payload: string): string {
  return createHash('sha256')
    .update(canonicalJson([asset, format, JSON.parse(payload)]))
    .digest('hex');
}
