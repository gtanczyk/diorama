import { expect, test } from 'vitest';
import type { Geometry } from '../src/play/geometry.ts';
import { classify, fixGrid, positions } from '../src/qa/explore.ts';
import type { ProbeHit } from '../src/qa/probe.ts';

const hit = (patch: Partial<ProbeHit> = {}): ProbeHit => ({ x: 600, y: 700, drawn: 5000, hidden: 0, overNearer: {}, hiddenByFarther: {}, overBox: {}, feetIn: [], off: 0, ...patch });

test('classify: stray pixels pass, real overlaps fail and name the thing', () => {
  expect(classify(hit()).issues).toEqual([]);
  expect(classify(hit({ overNearer: { barrel: 20 } })).issues).toEqual([]);
  const over = classify(hit({ overNearer: { barrel: 30, crate: 400 } }));
  expect(over.issues).toEqual(['drawn-over']);
  expect(over.worst).toBe('crate');
  expect(classify(hit({ feetIn: ['table'] })).worst).toBe('table');
  expect(classify(hit({ off: 0.5 })).issues).toEqual(['clipped']);
  expect(classify(hit({ hidden: 4900 })).issues).toEqual(['invisible']);
  expect(classify(hit({ hiddenByFarther: { wall: 200 } })).issues).toEqual(['hidden-in-front']);
  expect(classify(hit({ overBox: { lantern: 300 } }))).toMatchObject({ issues: ['over-box'], worst: 'lantern' });
});

const W = 1200, H = 896, CELL = 8;
function geometry(): Geometry {
  const rows = H / CELL;
  const walk = Array.from({ length: rows }, (_, r) => (r >= 60 ? '#'.repeat(W / CELL) : '.'.repeat(W / CELL)));
  return {
    frame: { width: W, height: H }, cell: CELL, walk, zone: walk.map((row) => row.replace(/#/g, '0')),
    scale: { horizonY: 300, pxPerY: 0.5 }, start: [600, 860],
    things: [{ key: 'well', box: [100, 400, 200, 500], stand: [150, 520] }], occluders: [],
  };
}

test('positions cover the floor on a lattice and include every spot', () => {
  const g = geometry();
  const spots = positions(g, 600);
  expect(spots.length).toBeLessThanOrEqual(601);
  expect(spots).toContainEqual([150, 520]);
  expect(spots.every(([, y]) => y >= 480)).toBe(true);
});

test('fixGrid closes cells around bad spots but never the start or a spot', () => {
  const g = geometry();
  const bad = classify(hit({ x: 900, y: 700, overNearer: { crate: 500 } }));
  const nearStart = classify(hit({ x: 600, y: 860, overNearer: { crate: 500 } }));
  const { geometry: fixed, closed } = fixGrid(g, [bad, nearStart]);
  expect(closed).toBe(9);
  expect(fixed.walk[Math.floor(700 / CELL)][Math.floor(900 / CELL)]).toBe('.');
  expect(fixed.walk[Math.floor(860 / CELL)][Math.floor(600 / CELL)]).toBe('#');
});

test('fixGrid refuses to close too much of a floor', () => {
  const g = geometry();
  const everywhere = positions(g).map(([x, y]) => classify(hit({ x, y, feetIn: ['x'] })));
  const { closed, undone } = fixGrid(g, everywhere);
  expect(closed).toBe(0);
  expect(undone[0]).toMatch(/would close/);
});
