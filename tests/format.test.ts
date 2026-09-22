import { expect, it } from 'vitest';
import { formatUsd } from '../src/lib/format';
it('shows costs in cents, rounding up and never presenting spend as free', () => {
  expect(formatUsd(0)).toBe('$0.00');
  expect(formatUsd(1)).toBe('under $0.01');
  expect(formatUsd(9_999)).toBe('under $0.01');
  expect(formatUsd(10_000)).toBe('$0.01');
  expect(formatUsd(10_001)).toBe('$0.02');
  expect(formatUsd(1_234_567)).toBe('$1.24');
});
