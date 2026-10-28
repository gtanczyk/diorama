import { afterEach, expect, test } from 'vitest';
import { sparkTier } from '../src/meta/spark.ts';
import { sparkUsd } from '../src/meta/prices.ts';

afterEach(() => delete process.env.DIORAMA_SPARK_TIER);

test('Spark goes to the contributor tier, except the person\'s own photos and drawings', () => {
  expect(sparkTier()).toBe('contributor');
  expect(sparkTier(true)).toBe('standard');
  process.env.DIORAMA_SPARK_TIER = 'standard';
  expect(sparkTier()).toBe('standard');
  process.env.DIORAMA_SPARK_TIER = 'contributor';
  expect(sparkTier(true)).toBe('contributor');
});

test('a Spark call costs what its tokens cost on its tier', () => {
  const usage = { input_tokens: 1_000_000, input_tokens_details: { cached_tokens: 400_000 }, output_tokens: 1_000_000 };
  expect(sparkUsd('standard', usage)).toBeCloseTo(0.6 * 1.25 + 0.4 * 0.15 + 4.25);
  expect(sparkUsd('contributor', usage)).toBeCloseTo(0.6 * 0.1 + 0.4 * 0.002 + 0.2);
  expect(sparkUsd('standard', undefined)).toBeUndefined();
});
