import { expect, test } from 'vitest';
import { patience } from '../src/meta/http.ts';

test('a SAM try waits long enough for a busy Meta side', () => {
  // Under load SAM answered in 60-115 s; a shorter limit dropped every try and set the place aside at masks.
  expect(patience('/responses', { model: 'sam-3.1' })).toBeGreaterThanOrEqual(120_000);
});

test('Muse edits wait for a busy Meta side, Spark keeps its limit', () => {
  expect(patience('/images/edits', { images: ['a', 'b'] })).toBe(180_000);
  expect(patience('/images/edits', { images: ['a'] })).toBe(150_000);
  expect(patience('/responses', { model: 'spark' })).toBe(240_000);
});
