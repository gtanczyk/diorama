import { expect, test } from 'vitest';
import { maskArea } from '../src/image/mask.ts';
import { rectMask } from '../src/image/raster.ts';
import { alikeLights, darkFloor, litFloor, measure } from '../src/scene/shadows.ts';

const W = 1200, H = 896;

test('a shadow running down-right from a base: direction and length per px of height', () => {
  // A 100 px tall post at x=400, base y=500; its shadow a band from the base 150 px toward lower right.
  const shadow = rectMask(W, H, [400, 495, 550, 505]);
  const m = measure(shadow, [400, 500], 100)!;
  expect(m.dir[0]).toBeCloseTo(1, 1);
  expect(Math.abs(m.dir[1])).toBeLessThan(0.1);
  expect(m.length).toBeGreaterThan(1.3);
  expect(m.length).toBeLessThan(1.5);
});

test('a dark ring right at the foot is contact shade, not a direction', () => {
  expect(measure(rectMask(W, H, [380, 495, 420, 505]), [400, 500], 100)).toBeUndefined();
});

test('dark floor: a darker patch counts, thin cracks and things off the floor do not', () => {
  const floor = rectMask(W, H, [0, 400, W, H]);
  const luma = new Uint8Array(W * H).fill(200);
  for (let y = 600; y < 640; y++) for (let x = 300; x < 500; x++) luma[y * W + x] = 90;
  for (let y = 400; y < H; y++) for (let x = 800; x < 802; x++) luma[y * W + x] = 60; // a crack between planks
  const dark = darkFloor(luma, litFloor(luma, floor), floor);
  expect(maskArea(dark)).toBe(200 * 40);
});

test('twin lamps are alike by what they are, not where they stand', () => {
  expect(alikeLights('lamp-post-near', 'lamp-post-far')).toBe(true);
  expect(alikeLights('street-lamp-left', 'street-lamp-right')).toBe(true);
  expect(alikeLights('lamp-post-near', 'lighthouse')).toBe(false);
  expect(alikeLights('lamp-near', 'lighthouse-windows')).toBe(false);
  expect(alikeLights('campfire', 'oil-lantern')).toBe(false);
});
