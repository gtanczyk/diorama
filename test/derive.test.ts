import { expect, test } from 'vitest';
import { emptyMask } from '../src/image/mask.ts';
import { rectMask, polygonMask } from '../src/image/raster.ts';
import { blobsOf, floorLine, lineYAt, lowerHull, simplifyLine, trimSteepEnds } from '../src/scene/occluders.ts';
import { fitLine, probePoints, scaleFrom } from '../src/scene/scale.ts';
import { connect, Grid, islands, reach, roomy } from '../src/scene/walk.ts';

const W = 1200, H = 896;

test('the lower hull bridges the gap between table legs', () => {
  expect(lowerHull([[0, 10], [5, 3], [10, 10]])).toEqual([[0, 10], [10, 10]]);
  expect(lowerHull([[0, 0], [5, 10], [10, 0]])).toEqual([[0, 0], [5, 10], [10, 0]]);
  // A table: two legs reaching y=100, the top between them ends at y=60.
  const table = rectMask(W, H, [100, 40, 300, 60]);
  for (const [x0, x1] of [[100, 110], [290, 300]]) for (let y = 60; y < 100; y++) table.bits.fill(1, y * W + x0, y * W + x1);
  const line = floorLine(table);
  expect(lineYAt(line, 200)).toBe(100);
});

test('an overhang is trimmed from the floor line', () => {
  expect(trimSteepEnds([[0, 10], [2, 80], [40, 82], [42, 20]])).toEqual([[2, 80], [40, 82]]);
  // A lamp post with an arm out to the left.
  const post = rectMask(W, H, [200, 100, 220, 500]);
  const arm = rectMask(W, H, [120, 100, 200, 140]);
  const both = { ...post, bits: post.bits.map((b, i) => b | arm.bits[i]) };
  const [blob] = blobsOf('post', both);
  expect(blob.line[0][0]).toBeGreaterThanOrEqual(195);
  expect(blob.baseY).toBe(500);
  expect(blob.foot.every(([, back, front]) => front - back <= 12)).toBe(true);
});

test('a slanted floor line is kept with few points', () => {
  const boat = polygonMask(W, H, [[100, 300], [500, 200], [500, 260], [100, 400]]);
  const line = simplifyLine(floorLine(boat));
  expect(line.length).toBeLessThanOrEqual(4);
  expect(lineYAt(line, 120)).toBeGreaterThan(lineYAt(line, 480));
});

test('a frame-tall blob is in front of everything', () => {
  const [tree] = blobsOf('tree', rectMask(W, H, [0, 0, 120, H]));
  expect(tree.front).toBe(true);
  expect(blobsOf('speck', rectMask(W, H, [0, 0, 20, 20]))).toEqual([]);
});

test('scale: a clean line, and a horizon that has to stay above the floor', () => {
  const samples = [{ y: 500, px: 100 }, { y: 600, px: 200 }, { y: 800, px: 400 }];
  expect(fitLine(samples)).toEqual({ c: 1, h: 400 });
  expect(scaleFrom(samples, 480, 300, 'spark').scale).toEqual({ horizonY: 400, pxPerY: 1, source: 'spark' });
  // The fitted horizon (400) is below the top floor (410 - 20), so the layout's is used with the slope refitted.
  const fixed = scaleFrom(samples, 410, 300, 'spark').scale!;
  expect(fixed.horizonY).toBe(300);
  expect(fixed.pxPerY).toBeGreaterThan(0.2);
  expect(scaleFrom([{ y: 500, px: 100 }], 480, 300, 'spark').scale?.horizonY).toBe(300);
  expect(scaleFrom([], 480, 300, 'spark').why).toBeDefined();
});

test('probe points run from the back of the floor to the front, two per depth', () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ y: 400 + i * 8, xs: [100, 600, 1100] }));
  const pts = probePoints(rows);
  expect(pts).toHaveLength(8);
  expect(pts[0].y).toBeLessThan(pts[7].y);
  expect(pts.slice(0, 2).map((p) => p.x)).toEqual([100, 600]);
  expect(probePoints(rows.map((r) => ({ ...r, xs: [600] })))).toHaveLength(4);
});

function gridOf(rows: string[]): Grid {
  const g = new Grid(rows[0].length, rows.length);
  rows.forEach((row, r) => [...row].forEach((ch, c) => (g.open[g.at(c, r)] = ch === '#' ? 1 : 0)));
  return g;
}

test('a one-cell corridor is too narrow to pass', () => {
  const g = gridOf([
    '###.###',
    '###.###',
    '#######',
    '#######',
  ]);
  expect(reach(g, 0)[g.at(6, 0)]).toBe(1);
  const narrow = gridOf([
    '###.###',
    '###.###',
    '###.###',
    '###.###',
  ]);
  narrow.open[narrow.at(3, 2)] = 1;
  expect(reach(narrow, 0)[narrow.at(6, 0)]).toBe(0);
  expect(islands(narrow).length).toBe(2);
  expect(roomy(narrow)[narrow.at(3, 2)]).toBe(0);
});

test('connect opens the cheapest two-wide path and drops specks', () => {
  const g = gridOf([
    '######.....######',
    '######.....######',
    '######.....######',
    '######.....######',
    '.................',
    '................#',
  ]);
  const wall = new Set([g.at(8, 0), g.at(8, 1)]);
  const done = connect(g, 0, (i) => (wall.has(i) ? Infinity : 1), 8);
  expect(done.stranded).toEqual([]);
  expect(reach(g, 0)[g.at(16, 0)]).toBe(1);
  expect(done.reopened).toBeGreaterThanOrEqual(10);
  expect(g.open[g.at(16, 5)]).toBe(0);
  expect(done.dropped).toBe(1);
});

test('an island no allowed path reaches is stranded, not opened through walls', () => {
  const g = gridOf(['###...###', '###...###', '###...###']);
  const done = connect(g, 0, () => Infinity, 4);
  expect(done.stranded).toHaveLength(1);
  expect(done.reopened).toBe(0);
  expect(emptyMask(1, 1).bits.length).toBe(1);
});

test('verify: a walkable, reachable place with sane scale is ok; a cut-off exit is an error', async () => {
  const { verifyPlace } = await import('../src/scene/verify.ts');
  const walk = Array.from({ length: 112 }, (_, r) => (r >= 60 ? '#'.repeat(150) : '.'.repeat(150)));
  const place = { key: 'yard', shows: 'a yard seen from above', mood: 'dusk', exits: [], things: [
    { key: 'gate', role: 'exit' as const, looks: 'a gate' }, { key: 'well', role: 'prop' as const, looks: 'a well' }] };
  const g = {
    frame: { width: 1200, height: 896 }, cell: 8, walk, zone: walk.map((row) => row.replace(/#/g, '0')),
    scale: { horizonY: 300, pxPerY: 0.6, source: 'spark' as const }, start: [600, 850] as [number, number],
    things: [
      { key: 'gate', role: 'exit' as const, box: [100, 300, 200, 480] as [number, number, number, number], mask: 'masks/gate.png', stand: [150, 500] as [number, number] },
      { key: 'well', role: 'prop' as const, box: [500, 400, 600, 520] as [number, number, number, number], mask: 'masks/well.png', stand: [550, 540] as [number, number] },
    ],
    occluders: [],
  };
  const notes = { things: {}, floors: { yard: { coarse: false, source: 'sam-text', iouLayout: 0.8 } } };
  expect(verifyPlace(place, g, notes)).toEqual({ ok: true, errors: [], flags: [] });
  const cut = { ...g, things: [{ ...g.things[0], stand: [150, 300] as [number, number] }, g.things[1]] };
  const verdict = verifyPlace(place, cut, notes);
  expect(verdict.ok).toBe(false);
  expect(verdict.errors.map((e) => e.code)).toEqual(['SPOT_UNREACHABLE']);
  expect(verifyPlace(place, { ...g, scale: { horizonY: 600, pxPerY: 0.6 } }, notes).errors.map((e) => e.code)).toContain('HORIZON_LOW');
});

test('scale takes: each point gets the median of what Spark said, skipped points drop out', async () => {
  const { medianPeople } = await import('../src/scene/scale.ts');
  const points = [{ x: 100, y: 500 }, { x: 300, y: 800 }];
  const takes = [[{ x: 100, y: 500, px: 100 }, { x: 300, y: 800, px: 300 }], [{ x: 101, y: 500, px: 140 }], [{ x: 100, y: 500, px: 120 }, { x: 300, y: 800, px: 260 }]];
  expect(medianPeople(points, takes)).toEqual([{ x: 100, y: 500, px: 120 }, { x: 300, y: 800, px: 280 }]);
});
