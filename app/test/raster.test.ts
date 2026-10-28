import { expect, test } from 'vitest';
import { maskArea } from '../src/image/mask.ts';
import { bottomRows, components, dilate, maskBox, maskIou, polygonMask, rectIou, rectMask, subtract, withoutSpecks } from '../src/image/raster.ts';

test('box overlap', () => {
  expect(rectIou([0, 0, 10, 10], [0, 0, 10, 10])).toBe(1);
  expect(rectIou([0, 0, 10, 10], [5, 0, 15, 10])).toBeCloseTo(50 / 150);
  expect(rectIou([0, 0, 10, 10], [20, 20, 30, 30])).toBe(0);
});

test('rect and polygon fills cover the same pixels', () => {
  const rect = rectMask(40, 30, [5, 4, 25, 20]);
  const poly = polygonMask(40, 30, [[5, 4], [25, 4], [25, 20], [5, 20]]);
  expect(maskArea(rect)).toBe(20 * 16);
  expect(maskIou(rect, poly)).toBe(1);
  expect(maskBox(rect)).toEqual([5, 4, 25, 20]);
});

test('blobs are split, sorted and filtered by size', () => {
  const big = rectMask(50, 50, [0, 0, 10, 10]);
  const small = rectMask(50, 50, [30, 30, 33, 33]);
  const both = { ...big, bits: big.bits.map((b, i) => b | small.bits[i]) };
  const blobs = components(both);
  expect(blobs.map(maskArea)).toEqual([100, 9]);
  expect(maskArea(withoutSpecks(both, 20))).toBe(100);
});

test('dilate grows and shrinks by a square', () => {
  const dot = rectMask(20, 20, [10, 10, 11, 11]);
  expect(maskBox(dilate(dot, 2))).toEqual([8, 8, 13, 13]);
  expect(maskArea(dilate(rectMask(20, 20, [5, 5, 15, 15]), -2))).toBe(36);
  expect(maskArea(subtract(rectMask(20, 20, [0, 0, 20, 20]), dot))).toBe(399);
});

test('bottom row per column', () => {
  const tri = polygonMask(10, 10, [[0, 0], [10, 0], [0, 10]]);
  const rows = bottomRows(tri);
  expect(rows[0]).toBeGreaterThanOrEqual(8);
  expect(rows[9]).toBeLessThanOrEqual(1);
  expect(rows[0]).toBeGreaterThan(rows[5]);
});
