import { expect, test } from 'vitest';
import { floorYAt, hiddenRuns, hides, lightFor, onStep, personPx, stepAt, stepFootY, stepRestY, type Geometry, type Occluder } from '../src/play/geometry.ts';
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

test('on stairs the feet rest on each tread and step over the risers', () => {
  const band = (t: number, b: number) => ({ x0: 100, every: 8, top: [t, t, t, t], bottom: [b, b, b, b] });
  const g = { steps: [band(600, 650), band(650, 700), band(700, 750)] } as unknown as Geometry;
  // Off the stairs, nothing changes.
  expect(stepFootY(g, 50, 640)).toBe(640);
  expect(stepFootY(g, 110, 580)).toBe(580);
  expect(stepFootY(g, 110, 760)).toBe(760);
  // Across a tread the feet stay at one height, and only climb over the riser.
  expect(stepFootY(g, 110, 666)).toBeCloseTo(stepFootY(g, 110, 680));
  const ys = Array.from({ length: 151 }, (_, i) => stepFootY(g, 110, 600 + i));
  for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThanOrEqual(ys[i - 1] - 1e-9);
  // On a tread the walker stays; on a riser it goes on to the next tread the way it walks.
  expect(stepRestY(g, 110, 675)).toBe(675);
  const up = stepRestY(g, 110, 645, -1);
  const down = stepRestY(g, 110, 645, 1);
  expect(up).toBeLessThan(645);
  expect(down).toBeGreaterThan(645);
  expect(stepFootY(g, 110, up)).toBeCloseTo(stepFootY(g, 110, up - 1));
  expect(stepFootY(g, 110, down)).toBeCloseTo(stepFootY(g, 110, down + 1));
  expect(stepRestY(g, 300, 690)).toBe(690);
});

test('a walker on a step knows which step and how deep in it, and can follow it across', () => {
  const g = { steps: [
    { x0: 0, every: 8, top: [600, 590, 580], bottom: [650, 640, 630] },
    { x0: 0, every: 8, top: [650, 640, 630], bottom: [700, 690, 680] },
  ] } as unknown as Geometry;
  expect(stepAt(g, 0, 625)).toEqual({ step: 0, at: 0.5 });
  expect(stepAt(g, 16, 670)?.step).toBe(1);
  expect(stepAt(g, 0, 720)).toBeUndefined();
  // Following step 0 to the right, the same depth in the band is higher up the picture.
  expect(onStep(g, 0, 16, 0.5)).toBe(605);
  expect(onStep(g, 0, 40, 0.5)).toBeUndefined();
});

test('a step hidden in part by a basket or a boat is mended from the rest of its edge', async () => {
  const { mendStep } = await import('../src/scene/stairs.ts');
  const top = Array.from({ length: 40 }, (_, i) => 500 + Math.round(0.02 * (i - 20) ** 2));
  const bottom = top.map((t) => t + 60);
  // A basket over columns 15..20 pushes the top down; a boat cuts columns 0..5 short.
  for (let i = 15; i <= 20; i++) top[i] += 40;
  for (let i = 0; i <= 5; i++) bottom[i] = top[i] + 20;
  const m = mendStep({ x0: 0, every: 8, top, bottom });
  for (let i = 15; i <= 20; i++) expect(Math.abs(m.top[i] - (500 + 0.02 * (i - 20) ** 2))).toBeLessThan(3);
  for (let i = 0; i <= 5; i++) expect(m.bottom[i] - m.top[i]).toBe(60);
});

test('a fire throws each shadow straight away from itself, fading a few heights away', () => {
  const g = { light: { dir: [0, 1], length: 1.5, strength: 0.5, at: [500, 600] } } as unknown as Geometry;
  const left = lightFor(g, 400, 600, 200)!;
  const right = lightFor(g, 600, 700, 200)!;
  expect(left.dir[0]).toBeCloseTo(-1);
  expect(right.dir[0]).toBeGreaterThan(0);
  expect(right.dir[1]).toBeGreaterThan(0);
  expect(left.strength).toBeGreaterThan(lightFor(g, 100, 600, 200)!.strength);
  expect(lightFor(g, 1400, 600, 200)).toBeUndefined();
  // The sun is the same for everyone.
  const sun = { light: { dir: [1, 0], length: 1, strength: 0.4 } } as unknown as Geometry;
  expect(lightFor(sun, 10, 10, 100)).toEqual(sun.light);
});

test('a flame sways and breathes; a lamp stays put', () => {
  const lamp = { scale: { horizonY: 200, pxPerY: 0.5 }, light: { dir: [0, 1], length: 1.5, strength: 0.5, at: [500, 600] } } as unknown as Geometry;
  const fire = { ...lamp, light: { ...lamp.light, flame: true } } as Geometry;
  const at = (g: Geometry, t: number) => lightFor(g, 700, 600, 200, t)!;
  expect(at(lamp, 1)).toEqual(at(lamp, 2));
  const xs = [0.3, 0.9, 1.7, 2.4].map((t) => at(fire, t).at![0]);
  expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(1);
  // Never more than its sway (0.1 m: 200 px is 1.62 m) to either side.
  for (const x of xs) expect(Math.abs(x - 500)).toBeLessThanOrEqual(200 * (0.1 / 1.62) + 1e-9);
  expect(at(fire, 0.3).strength).not.toBe(at(fire, 0.9).strength);
});
