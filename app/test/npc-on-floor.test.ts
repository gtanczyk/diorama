import { expect, test } from 'vitest';
import { NPC_MIN_PX, npcInSight, npcOnFloor } from '../src/scene/derive.ts';
import { CELL, Grid, reach, roomy } from '../src/scene/walk.ts';

// A 1200x896 place whose only floor is a boat deck at y 600-740, x 300-700 (the sea and sky are not walkable).
const grid = new Grid(1200 / CELL, 896 / CELL);
for (let r = Math.floor(600 / CELL); r < 740 / CELL; r++) for (let c = Math.floor(300 / CELL); c < 700 / CELL; c++) grid.open[grid.at(c, r)] = 1;
const cells = roomy(grid);
const reached = reach(grid, grid.cellOf(500, 680), cells);

test('an npc laid out in the sky steps onto the nearest reachable floor, sized for the depth there', () => {
  const moved = npcOnFloor([20, 40, 220, 150], grid, reached, { horizonY: 120 })!;
  expect(moved).toBeDefined();
  const [x0, y0, x1, y1] = moved;
  expect(grid.open[grid.cellOf((x0 + x1) / 2, y1 - 1)]).toBe(1);
  // Nearer the camera, so bigger than its 200x110 box at y 150.
  expect(x1 - x0).toBeGreaterThan(200);
  expect(y1 - y0).toBeGreaterThan(110);
});

test('an npc already standing on the deck stays where it is', () => {
  expect(npcOnFloor([450, 520, 550, 680], grid, reached, { horizonY: 120 })).toBeUndefined();
});

// The same place seen from the hill: floor from y 300 to the bottom, the horizon at 200, a grown-up 0.665 px per px
// below it (notebook-monsters' dragon hill).
const hill = new Grid(1200 / CELL, 896 / CELL);
for (let r = Math.floor(300 / CELL); r < 896 / CELL; r++) for (let c = 0; c < 1200 / CELL; c++) hill.open[hill.at(c, r)] = 1;
const hillReached = reach(hill, hill.cellOf(600, 800), roomy(hill));
const hillScale = { horizonY: 200, pxPerY: 0.665 };

test('an npc laid out so deep the game draws it a speck steps forward until it is big enough to read', () => {
  // A dragon at the back of its cave, feet 110 px below the horizon: a grown-up there is 73 px tall.
  const moved = npcInSight([495, 80, 705, 310], hill, hillReached, hillScale, 2.8)!;
  expect(moved).toBeDefined();
  const [x0, y0, x1, y1] = moved;
  expect(hillScale.pxPerY * (y1 - hillScale.horizonY)).toBeGreaterThanOrEqual(NPC_MIN_PX - CELL);
  expect(Math.abs((x0 + x1) / 2 - 600)).toBeLessThanOrEqual(CELL);
  expect(hill.open[hill.cellOf((x0 + x1) / 2, y1 - 1)]).toBe(1);
  // Its box is the dragon as the game draws it there: 2.8 m by the scale, its shape kept.
  expect(y1 - y0).toBeCloseTo((2.8 / 1.62) * hillScale.pxPerY * (y1 - hillScale.horizonY), 0);
  expect((x1 - x0) / (y1 - y0)).toBeCloseTo(210 / 230, 2);
});

test('an npc near enough to read stays where the layout put it', () => {
  expect(npcInSight([500, 300, 600, 600], hill, hillReached, hillScale)).toBeUndefined();
});
