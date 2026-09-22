// Display costs in cents. Values are upper bounds or rated usage, so round up and
// never show a nonzero amount as free.
export function formatUsd(microusd: number) {
  if (microusd <= 0) return '$0.00';
  if (microusd < 10_000) return 'under $0.01';
  return `$${(Math.ceil(microusd / 10_000) / 100).toFixed(2)}`;
}
