import { expect, test } from 'vitest';
import { emptyMask } from '../src/image/mask.ts';
import type { Geometry } from '../src/play/geometry.ts';
import { fallsIn, Weather } from '../src/play/weather.ts';
import { dripEdge } from '../src/scene/weather.ts';

const W = 400;
const H = 300;
/** Floor (walkable) from row 200 down. */
const g = {
  frame: { width: W, height: H }, cell: 10,
  walk: Array.from({ length: 30 }, (_, r) => (r >= 20 ? '#' : '.').repeat(40)),
  scale: { horizonY: 80, pxPerY: 0.8 }, start: [200, 250], things: [], occluders: [],
} as unknown as Geometry;

test('an eave drips from its lowest edge to the floor under it', () => {
  // A roof: rows 60..100 over columns 100..300, its eave at row 99.
  const roof = emptyMask(W, H);
  for (let y = 60; y < 100; y++) roof.bits.fill(1, y * W + 100, y * W + 300);
  const { from, to } = dripEdge(roof, g);
  expect(from.length).toBeGreaterThan(4);
  expect(from.every(([x, y]) => x >= 100 && x < 300 && y === 100)).toBe(true);
  expect(to.every((t) => t === 205)).toBe(true);
});

test('nothing drips from an empty mask', () => {
  expect(dripEdge(emptyMask(W, H), g).from).toEqual([]);
});

test('a rainy mood leaves the falling rain to the page', () => {
  expect(fallsIn('night, heavy rain, lantern light')).toBe(true);
  expect(fallsIn('wieczór, deszcz')).toBe(true);
  expect(fallsIn('a sunny morning, brainstorm at the drained pond')).toBe(false);
  expect(Weather.parse({ fall: 'rain', strength: 0.6, wind: 0.1 }).drips).toEqual([]);
});
