import { expect, test } from 'vitest';
import { rectMask } from '../src/image/raster.ts';
import { doorsOn } from '../src/scene/derive.ts';
import type { Layout } from '../src/scene/layout.ts';
import { doorCheck, isDoor, scaleFrom, type Sample } from '../src/scene/scale.ts';

const W = 1200, H = 896;

// A bedroom painted from a photo: Spark's people (median of three asks) put the horizon at the door's middle,
// so the hero by the door was half its height. The door's foot is at y=411, cut off by the frame's top.
const spark: Sample[] = [
  { x: 780, y: 460, px: 232 }, { x: 908, y: 460, px: 232 }, { x: 644, y: 596, px: 476 }, { x: 884, y: 596, px: 476 },
  { x: 604, y: 740, px: 732 }, { x: 908, y: 740, px: 732 }, { x: 580, y: 868, px: 962 }, { x: 916, y: 868, px: 962 },
];

test('a person by the door is about as tall as the door says, not half of it', () => {
  const { scale } = scaleFrom(spark, 415, 420, 'spark');
  expect(scale!.horizonY).toBeGreaterThan(320);
  const door = { key: 'bedroom-door', y: 411, px: (411 * 1.62) / 2.05, atLeast: true };
  const checked = doorCheck(scale!, spark, door, 415)!;
  expect(checked.scale).toBeDefined();
  const s = checked.scale!;
  const atDoor = s.pxPerY * (411 - s.horizonY);
  expect(atDoor).toBeCloseTo(door.px, 0);
  expect(s.horizonY).toBeLessThan(250);
  // Nearer rows still grow (Spark's slope is kept as far as the door allows).
  expect(s.pxPerY * (700 - s.horizonY)).toBeGreaterThan(600);
});

test('a scale that agrees with the door is left alone; a cut-off door never shrinks the hero', () => {
  const scale = { horizonY: 150, pxPerY: 1.25, source: 'spark' as const };
  expect(doorCheck(scale, spark, { key: 'door', y: 411, px: 325, atLeast: false }, 415)).toBeUndefined();
  // The hero is taller than the door's lower bound: fine.
  expect(doorCheck(scale, spark, { key: 'door', y: 411, px: 200, atLeast: true }, 415)).toBeUndefined();
  // Not cut off and the hero towers over it: pulled down.
  expect(doorCheck(scale, spark, { key: 'door', y: 411, px: 200, atLeast: false }, 415)?.scale).toBeDefined();
});

test('doors are told from things that only have a door', () => {
  expect(isDoor('bedroom-door wooden door', 2.05)).toBe(true);
  expect(isDoor('front-door', 2.1)).toBe(true);
  expect(isDoor('cellar doorway', 2)).toBe(true);
  expect(isDoor('trapdoor', 1)).toBe(false);
  expect(isDoor('oven-door', 2)).toBe(false);
  expect(isDoor('door-mat', 0.1)).toBe(false);
  expect(isDoor('outdoor-bench', 1)).toBe(false);
  expect(isDoor('wardrobe door', 2)).toBe(false);
});

test('a wall door standing on the floor becomes a reference', () => {
  const layout = { things: [{ key: 'bedroom-door', metres: 2.05 }] } as unknown as Layout;
  const ground = rectMask(W, H, [0, 415, W, H]);
  const door = rectMask(W, H, [730, 0, 917, 411]);
  const [d] = doorsOn([{ key: 'bedroom-door', kind: 'wall', phrase: 'wooden door', source: 'sam-text', coarse: false, mask: door }], layout, ground);
  expect(d.door.atLeast).toBe(true);
  expect(d.door.y).toBeGreaterThan(405);
  expect(d.door.px).toBeGreaterThan(300);
  // A door hanging on the wall with no floor under it is no measure.
  expect(doorsOn([{ key: 'bedroom-door', kind: 'wall', source: 'sam-text', coarse: false, mask: rectMask(W, H, [730, 0, 917, 300]) }], layout, ground)).toEqual([]);
});
