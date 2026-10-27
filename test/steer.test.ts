import { describe, expect, it } from 'vitest';
import { WalkGrid, type Point } from '../src/play/path.ts';

// '#' is floor; cells are 10 px.
const grid = (...rows: string[]) => new WalkGrid({ cell: 10, walk: rows });

describe('WalkGrid.steer', () => {
  it('goes straight on open floor', () => {
    const g = grid('#####', '#####', '#####');
    expect(g.steer([25, 25], [1, 0], 8)).toEqual([33, 25]);
  });

  it('slides along a wall when pushed into it diagonally', () => {
    const g = grid('.....', '#####', '#####');
    const to = g.steer([25, 12], [1, -1], 8)!;
    expect(to[0]).toBeGreaterThan(25);
    expect(g.walkable(...to)).toBe(true);
  });

  it('sidesteps into a doorway that is a little to one side', () => {
    // A wall across row 1 with a one-cell door at column 3; the walker stands below column 2 pushing up.
    const g = grid('#####', '...#.', '#####');
    let at: Point = [24, 25];
    for (let i = 0; i < 10 && at[1] > 10; i++) at = g.steer(at, [0, -1], 8) ?? at;
    expect(at[1]).toBeLessThan(10);
  });

  it('steers from the floor beside a walker standing just off it', () => {
    const g = grid('#####', '##...');
    expect(g.steer([35, 15], [-1, 0], 8)).toBeDefined();
  });

  it('stays put facing a solid wall', () => {
    const g = grid('.....', '#####');
    expect(g.steer([25, 15], [0, -1], 8)).toBeUndefined();
  });
});
