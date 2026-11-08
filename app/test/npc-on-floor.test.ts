import { expect, test } from 'vitest';
import { npcOnFloor } from '../src/scene/derive.ts';
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
