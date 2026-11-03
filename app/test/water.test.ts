import { expect, test } from 'vitest';
import { emptyMask, maskArea, type Mask } from '../src/image/mask.ts';
import { Depth, waterMask } from '../src/scene/layers.ts';

const W = 1200;
const H = 896;
const rect = (x0: number, y0: number, x1: number, y1: number): Mask => {
  const m = emptyMask(W, H);
  for (let y = y0; y < y1; y++) m.bits.fill(1, y * W + x0, y * W + x1);
  return m;
};
const at = (m: Mask, x: number, y: number) => m.bits[y * W + x];
const none = Depth.parse({});

// A river across the frame (y 340..470), the bridge standing over its middle.
const river = rect(0, 340, W, 470);
const bridge = rect(400, 300, 720, 600);

test('a floor taken from the layout that covers the river does not stop it flowing (only a strip at the bank moved)', () => {
  // The "far bank" floor came from the layout as a rectangle: the grass behind the river and the river itself.
  const farBank = rect(0, 300, W, 460);
  const frontBank = rect(0, 470, W, H);
  const { mask, swallowed } = waterMask(river, bridge, [{ key: 'far-bank', mask: farBank }, { key: 'front-bank', mask: frontBank }], none);
  expect(swallowed).toEqual(['far-bank']);
  expect(at(mask, 200, 400)).toBe(1);
  expect(at(mask, 1000, 360)).toBe(1);
  // The bridge never flows, nor the front bank.
  expect(at(mask, 560, 400)).toBe(0);
  expect(at(mask, 200, 500)).toBe(0);
  expect(maskArea(mask)).toBeGreaterThan(0.6 * maskArea(river));
});

test('wet planks SAM took for water stay dry: a floor holding a little of the water keeps it out', () => {
  const jetty = rect(100, 420, 300, 470);
  const { mask, swallowed } = waterMask(river, emptyMask(W, H), [{ key: 'jetty', mask: jetty }], none);
  expect(swallowed).toEqual([]);
  expect(at(mask, 200, 450)).toBe(0);
  expect(at(mask, 600, 400)).toBe(1);
});

test('puddles in a cobbled street stay still: the street holds the water but is mostly not water', () => {
  const street = rect(0, 400, W, H);
  const puddles = rect(300, 600, 500, 650);
  const { mask, swallowed } = waterMask(puddles, emptyMask(W, H), [{ key: 'street', mask: street }], none);
  expect(swallowed).toEqual([]);
  expect(maskArea(mask)).toBe(0);
});

test('the author adds cells SAM missed and removes cells that are not water (water_area)', () => {
  // SAM saw only the left half; F7 (x 300..360, y 360..420) is in it, P7 (x 900..960) is not.
  const left = rect(0, 340, 600, 470);
  const { mask } = waterMask(left, emptyMask(W, H), [], Depth.parse({ waterAdd: ['P7'], waterRemove: ['F7'] }));
  expect(at(mask, 930, 390)).toBe(1);
  expect(at(mask, 330, 390)).toBe(0);
  expect(at(mask, 100, 390)).toBe(1);
});

test('a whole cell the author adds on the shore leaves the quay boards in it dry', () => {
  // N9 (x 780..840, y 480..540): the quay's corner reaches into it, SAM saw no water there.
  const quay = rect(0, 480, 800, H);
  const { mask } = waterMask(emptyMask(W, H), emptyMask(W, H), [{ key: 'quay', mask: quay }], Depth.parse({ waterAdd: ['N9'] }));
  expect(at(mask, 830, 510)).toBe(1);
  expect(at(mask, 790, 510)).toBe(0);
});
