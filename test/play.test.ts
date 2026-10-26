import { expect, test } from 'vitest';
import { floorYAt, hiddenRuns, hides, personPx, type Geometry, type Occluder } from '../src/play/geometry.ts';
import { WalkGrid } from '../src/play/path.ts';
import { previewGeometry } from '../src/play/preview.ts';
import type { Layout } from '../src/scene/layout.ts';
import type { Place } from '../src/world/schema.ts';

// 10 x 6 cells of 10 px; a wall in column 4 with a gap in the bottom row.
const walk = ['####.#####', '####.#####', '####.#####', '####.#####', '####.#####', '##########'];

test('route goes around a wall through its gap and is straightened', () => {
  const grid = new WalkGrid({ cell: 10, walk });
  const path = grid.route([15, 15], [85, 15]);
  expect(path.length).toBeGreaterThan(1);
  expect(path[path.length - 1]).toEqual([85, 15]);
  for (let i = 0, at: [number, number] = [15, 15]; i < path.length; at = path[i++]) expect(grid.clear(at, path[i])).toBe(true);
  expect(Math.max(...path.map(([, y]) => y))).toBeGreaterThanOrEqual(50);
});

test('a click off the floor snaps to the nearest walkable cell', () => {
  const grid = new WalkGrid({ cell: 10, walk });
  expect(grid.snap(45, 25)).toEqual([35, 25]);
  expect(grid.route([15, 15], [45, 25]).at(-1)).toEqual([35, 25]);
});

test('no route between floors that never touch', () => {
  const grid = new WalkGrid({ cell: 10, walk: ['##..##', '##..##'] });
  expect(grid.route([5, 5], [55, 5])).toEqual([]);
});

const barrel: Occluder = { key: 'barrel#1', box: [100, 200, 200, 300], baseY: 300, floor: [[100, 280], [150, 300], [200, 280]] };

test('an occluder hides feet behind its floor line, per column', () => {
  expect(floorYAt(barrel, 150)).toBe(300);
  expect(floorYAt(barrel, 125)).toBe(290);
  expect(floorYAt(barrel, 50)).toBe(280);
  expect(hides(barrel, 150, 285)).toBe(true);
  expect(hides(barrel, 105, 285)).toBe(false);
  expect(hides(barrel, 150, 310)).toBe(false);
  expect(hiddenRuns(barrel, 90, 210, 285)).toEqual([[128, 172]]);
});

test('a thing on another hides exactly when its support does; front always hides', () => {
  const pot: Occluder = { key: 'pot#1', box: [140, 150, 160, 200], baseY: 200, on: 'barrel#1' };
  const support = (k: string) => (k === barrel.key ? barrel : undefined);
  expect(hides(pot, 150, 250, support)).toBe(true);
  expect(hides(pot, 150, 320, support)).toBe(false);
  expect(hides({ ...pot, on: undefined, front: true }, 150, 999)).toBe(true);
});

test('preview geometry walks the layout floors around things, scaled by their heights', () => {
  const place: Place = {
    key: 'yard', shows: 'an inn yard seen from above', mood: 'dusk', exits: [],
    things: [{ key: 'well', role: 'prop', looks: 'stone well' }, { key: 'innkeeper', role: 'npc', looks: 'a stout man' }],
  };
  const layout: Layout = {
    horizon: 300, sky: '#8899aa', ground: '#556644',
    floors: [{ key: 'yard', is: 'packed earth', colour: '#776655', outline: [[0, 896], [0, 400], [1200, 400], [1200, 896]] }],
    things: [
      { key: 'well', colour: '#888888', x: 600, footY: 600, width: 120, height: 150, metres: 1.62 },
      { key: 'innkeeper', colour: '#aa6644', x: 300, footY: 700, width: 60, height: 160, metres: 1.7 },
    ],
    lights: [],
  };
  const g: Geometry = previewGeometry(layout, place);
  const grid = new WalkGrid(g);
  expect(grid.walkable(600, 590)).toBe(false);
  expect(grid.walkable(600, 620)).toBe(true);
  expect(grid.walkable(300, 690)).toBe(true);
  expect(grid.walkable(600, 350)).toBe(false);
  expect(g.occluders.map((o) => o.key)).toEqual(['well']);
  expect(personPx(g, 600)).toBeGreaterThan(100);
  expect(grid.walkable(...g.things[0].stand)).toBe(true);
});
