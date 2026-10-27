import { expect, test } from 'vitest';
import type { Geometry } from '../src/play/geometry.ts';
import { diagnose } from '../src/scene/diagnose.ts';

/** 1200x896 at 8 px: a front floor and a back floor with a band of closed rows between. */
function geometry(band: [number, number]): Geometry {
  const cols = 150;
  const walk: string[] = [];
  const zone: string[] = [];
  for (let r = 0; r < 112; r++) {
    const floor = r >= 30 && r < 60 ? '1' : r >= 60 ? '0' : '.';
    const open = floor !== '.' && !(r >= band[0] && r < band[1]);
    walk.push((open ? '#' : '.').repeat(cols));
    zone.push((floor !== '.' ? floor : '.').repeat(cols));
  }
  return {
    frame: { width: 1200, height: 896 }, cell: 8, walk, zone,
    scale: { horizonY: 100, pxPerY: 0.5, source: 'spark' },
    start: [600, 850],
    things: [
      { key: 'bell', role: 'item', box: [100, 260, 140, 300], stand: [120, 300] },
    ],
    occluders: [],
  } as Geometry;
}

test('an unreached floor comes with the 60 px cells of its shortest gap, and an unreachable spot with the nearest reachable point', () => {
  const d = diagnose(geometry([58, 64]));
  expect(d.floors.find((f) => f.floor === 1)!.reached).toBe(0);
  expect(d.patches).toHaveLength(1);
  const gap = d.patches[0].gap!;
  expect(gap.px).toBeLessThan(60);
  expect(gap.cells.length).toBeGreaterThan(0);
  for (const c of gap.cells) expect(c).toMatch(/^[A-T](8|9)$/);
  expect(d.patches[0].floors).toEqual([1]);
  expect(d.spots).toEqual([expect.objectContaining({ thing: 'bell', nearest: expect.any(Array) })]);
});

test('a place that walks everywhere has no patches', () => {
  const d = diagnose(geometry([0, 0]));
  expect(d.patches).toEqual([]);
  expect(d.start.onFloor).toBe(true);
});
