import { expect, it } from 'vitest';
import { money, tokens, usdLimit, pricedCost } from '../server/domain/money';
import { costMicro, freePrice } from '../server/services/costs';
const price = {
  ...freePrice,
  source: 'https://example.com/pricing',
  inputUsdPerMillion: 0.1,
  outputUsdPerMillion: 0.2,
};
it('rounds decimal costs upward only after combining exact input and output costs', () => {
  expect(costMicro(10, 0, { ...price, inputUsdPerMillion: 0.07 })).toBe(1);
  expect(costMicro(100, 0, { ...price, inputUsdPerMillion: 0.07 })).toBe(7);
  expect(costMicro(1, 1, price)).toBe(1);
  expect(costMicro(0, 0, price)).toBe(0);
  expect(costMicro(1, 0, { ...price, inputUsdPerMillion: 1e-7 })).toBe(1);
  expect(usdLimit(0.000001)).toBe(1);
  expect(usdLimit(0.0000009)).toBe(0);
});
it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid integer quantity %s',
  (value) => {
    expect(() => money(value)).toThrow();
    expect(() => tokens(value)).toThrow();
    expect(() => costMicro(value, 0, price)).toThrow();
  },
);
it('preserves the safe integer boundary and rejects product and sum overflow', () => {
  expect(money(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  expect(() => money(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow();
  expect(costMicro(Number.MAX_SAFE_INTEGER, 0, { ...price, inputUsdPerMillion: 1 })).toBe(
    Number.MAX_SAFE_INTEGER,
  );
  expect(() =>
    costMicro(Number.MAX_SAFE_INTEGER, 1, {
      ...price,
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 1,
    }),
  ).toThrow();
  expect(() =>
    costMicro(Number.MAX_SAFE_INTEGER, 0, { ...price, inputUsdPerMillion: 2 }),
  ).toThrow();
  expect(() => usdLimit(Number.MAX_SAFE_INTEGER)).toThrow();
});
it.each([-1, NaN, Infinity])('rejects invalid rates and budget %s', (value) => {
  expect(() => usdLimit(value)).toThrow();
  expect(() => costMicro(1, 1, { ...price, inputUsdPerMillion: value })).toThrow();
});
it('requires token quantities at the arithmetic boundary', () => {
  expect(pricedCost(tokens(10), tokens(5), price)).toBe(2);
});
