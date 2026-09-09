import { z } from 'zod';

export const microusd = z.number().int().nonnegative().brand<'Microusd'>();
export type Microusd = z.infer<typeof microusd>;
export const tokenCount = z.number().int().nonnegative().brand<'TokenCount'>();
export type TokenCount = z.infer<typeof tokenCount>;
export const modelPrice = z
  .object({
    inputUsdPerMillion: z.number().nonnegative(),
    outputUsdPerMillion: z.number().nonnegative(),
    vision: z.boolean(),
    imageTokenBound: tokenCount,
    source: z.union([z.url(), z.literal('local mock')]),
    verifiedAt: z.iso.date(),
  })
  .strict()
  .refine(
    (p) => p.source !== 'local mock' || (p.inputUsdPerMillion === 0 && p.outputUsdPerMillion === 0),
    'Local mock pricing must be free',
  )
  .refine(
    (p) => !p.vision || p.imageTokenBound > 0 || p.source === 'local mock',
    'Vision models require a conservative image token bound',
  );
export type ModelPrice = z.input<typeof modelPrice>;

export function money(value: number | bigint): Microusd {
  if (typeof value === 'bigint' && (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)))
    throw new RangeError('Micro-USD amount exceeds safe integer range');
  const parsed = microusd.safeParse(Number(value));
  if (!parsed.success) throw new RangeError('Invalid micro-USD amount');
  return parsed.data;
}
export function tokens(value: number): TokenCount {
  const parsed = tokenCount.safeParse(value);
  if (!parsed.success) throw new RangeError('Invalid token count');
  return parsed.data;
}
// Treat the configured decimal representation as exact, including scientific notation.
// Floating-point multiplication before rounding can overcharge or under-reserve.
function decimal(value: number): [bigint, bigint] {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('Invalid monetary rate');
  const [mantissa, exponent = '0'] = value.toString().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const scale = fraction.length - Number(exponent);
  const numerator = BigInt(whole + fraction);
  return scale >= 0 ? [numerator, 10n ** BigInt(scale)] : [numerator * 10n ** BigInt(-scale), 1n];
}
export function usdLimit(value: number): Microusd {
  const [n, d] = decimal(value);
  return money((n * 1000000n) / d);
}
export function pricedCost(input: TokenCount, output: TokenCount, price: ModelPrice): Microusd {
  const [a, b] = decimal(price.inputUsdPerMillion),
    [c, d] = decimal(price.outputUsdPerMillion);
  const numerator = BigInt(tokens(input)) * a * d + BigInt(tokens(output)) * c * b;
  const denominator = b * d;
  return money((numerator + denominator - 1n) / denominator);
}
