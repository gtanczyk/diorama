import { expect, test } from 'vitest';
import { maskArea } from '../src/image/mask.ts';
import { rectMask, union } from '../src/image/raster.ts';
import { cellsBox, cellsMask, parseCell } from '../src/scene/locate.ts';
import { hollowFault, pickInstances, scoreFloor, thingMaskFault } from '../src/scene/masks.ts';
import type { Found } from '../src/meta/sam.ts';

const W = 1200, H = 896;
const found = (rect: [number, number, number, number], id = '0'): Found =>
  ({ id, box: { left: rect[0], top: rect[1], right: rect[2], bottom: rect[3] }, mask: rectMask(W, H, rect) });

test('the sanity gate: empty, far too big, or elsewhere', () => {
  const box: [number, number, number, number] = [100, 100, 200, 200];
  expect(thingMaskFault(rectMask(W, H, [0, 0, 0, 0]), box)).toBe('empty');
  expect(thingMaskFault(rectMask(W, H, [110, 110, 190, 195]), box)).toBeUndefined();
  expect(thingMaskFault(rectMask(W, H, [0, 0, 1200, 600]), box)).toMatch(/over 3x/);
  expect(thingMaskFault(rectMask(W, H, [600, 600, 700, 700]), box)).toMatch(/outside/);
});

test('a ring around the thing is hollow', () => {
  const box: [number, number, number, number] = [100, 100, 400, 400];
  const ring = union(rectMask(W, H, [80, 80, 420, 150]), rectMask(W, H, [80, 350, 420, 420]));
  expect(hollowFault(ring, box)).toMatch(/middle/);
  expect(hollowFault(rectMask(W, H, box), box)).toBeUndefined();
});

test('instances: the nearest one plus those inside the box, never a reflection far away', () => {
  const box: [number, number, number, number] = [100, 100, 300, 300];
  const mask = pickInstances([found([110, 110, 200, 290], '0'), found([210, 150, 290, 250], '1'), found([100, 600, 300, 800], '2')], box)!;
  expect(maskArea(mask)).toBe(90 * 180 + 80 * 100);
  expect(pickInstances([found([700, 700, 800, 800])], box)).toBeUndefined();
});

test('grid cells', () => {
  expect(parseCell('A1')).toEqual([0, 0]);
  expect(parseCell('t15')).toEqual([19, 14]);
  expect(parseCell('U1')).toBeUndefined();
  expect(parseCell('A16')).toBeUndefined();
  expect(cellsBox(['B2', 'C4'])).toEqual([60, 60, 180, 240]);
  expect(maskArea(cellsMask(['A15']))).toBe(60 * (896 - 840));
});

test('a floor candidate is clipped near the marked cells and scored against them', () => {
  const marked = cellsMask(['A10', 'B10', 'C10']);
  const good = scoreFloor(rectMask(W, H, [0, 540, 180, 600]), marked);
  const wide = scoreFloor(rectMask(W, H, [0, 0, 1200, 896]), marked);
  expect(good.iou).toBe(1);
  expect(wide.iou).toBeLessThan(0.3);
  expect(maskArea(wide.mask)).toBeLessThan(W * H / 4);
});

test('colour cut: a dark thing on light floor comes out as one solid blob, holes filled', async () => {
  const { colourCut, loneMatch } = await import('../src/scene/masks.ts');
  const rgb = Buffer.alloc(W * H * 3, 200);
  // A dark ring-shaped thing (a hole in the middle that is floor-coloured) in 300..500 x 300..500.
  for (let y = 320; y < 480; y++) for (let x = 330; x < 470; x++) {
    const inner = x > 380 && x < 420 && y > 380 && y < 420;
    if (!inner) rgb.fill(40, (y * W + x) * 3, (y * W + x) * 3 + 3);
  }
  const cut = colourCut(rgb, [300, 300, 500, 500])!;
  expect(maskArea(cut)).toBe(140 * 160);
  expect(colourCut(Buffer.alloc(W * H * 3, 200), [300, 300, 500, 500])).toBeUndefined();
  expect(loneMatch([520, 300, 720, 500], [300, 300, 500, 500])).toBe(true);
  expect(loneMatch([900, 300, 1100, 500], [300, 300, 500, 500])).toBe(false);
  expect(loneMatch([300, 300, 320, 320], [300, 300, 500, 500])).toBe(false);
});
