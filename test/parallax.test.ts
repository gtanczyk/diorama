import { expect, test } from 'vitest';
import type { Geometry } from '../src/play/geometry.ts';
import { backdropTransforms, disparity, floorPoint, overscan, shiftAt, stackCards, type Parallax } from '../src/play/parallax.ts';

const g = { frame: { width: 1200, height: 896 }, cell: 8, walk: ['#'], scale: { horizonY: 200, pxPerY: 0.6 }, start: [10, 10], things: [], occluders: [] } as unknown as Geometry;
const p: Parallax = { cam: { x: 0.7, y: -0.4 }, pivot: 0.5, px: 22 };

test('the floor under a card moves exactly as the card standing on it', () => {
  const { below } = backdropTransforms(g, p);
  for (const y of [300, 548, 700, 896]) {
    const [dx, dy] = shiftAt(g, p, y);
    // A floor point (x, y) through the backdrop's shear.
    expect(below[2] * y + below[4]).toBeCloseTo(dx, 6);
    expect(below[3] * y + below[5] - y).toBeCloseTo(dy, 6);
  }
});

test('the backdrop pieces meet at the horizon and the pivot row stays put', () => {
  const { above, below } = backdropTransforms(g, p);
  const h = g.scale.horizonY;
  expect(above[4]).toBeCloseTo(below[2] * h + below[4], 6);
  expect(above[5]).toBeCloseTo(below[3] * h + below[5] - h, 6);
  const still = 200 + 0.5 * 696;
  expect(disparity(g, still)).toBeCloseTo(0.5);
  expect(shiftAt(g, p, still)).toEqual([0, -0]);
});

test('a click on the sheared floor finds the painting point under it', () => {
  for (const [x, y] of [[100, 250], [600, 548], [1100, 880], [400, 120]] as const) {
    const [dx, dy] = y < g.scale.horizonY ? [backdropTransforms(g, p).above[4], backdropTransforms(g, p).above[5]] : shiftAt(g, p, y);
    const [px, py] = floorPoint(g, p, x + dx, y + dy);
    expect(px).toBeCloseTo(x, 4);
    expect(py).toBeCloseTo(y, 4);
  }
});

test('the zoom covers the frame edges at a full swing', () => {
  const z = overscan(g, { ...p, cam: { x: 1, y: 1 } });
  const [dx] = shiftAt(g, { ...p, cam: { x: 1, y: 1 } }, 896);
  expect((z - 1) * 600).toBeGreaterThanOrEqual(Math.abs(dx) - 1e-9);
});

test('a post SAM cut into a cap and a foot becomes one card standing on the foot', () => {
  const cap = { key: 'post#1', thing: 'post', box: [315, 497, 423, 614], baseY: 614 };
  const foot = { key: 'post#2', thing: 'post', box: [316, 636, 421, 734], baseY: 734 };
  const other = { key: 'post#3', thing: 'post', box: [547, 555, 641, 665], baseY: 665 };
  const cards = stackCards([cap, foot, other] as never);
  expect(cards.map((c) => c.key)).toEqual(['post#2', 'post#3']);
  expect(cards[0]).toMatchObject({ box: [315, 497, 423, 734], baseY: 734, stacked: true });
});
