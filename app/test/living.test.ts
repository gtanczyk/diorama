import { expect, test } from 'vitest';
import { emptyMask, type Mask } from '../src/image/mask.ts';
import { leapHeight, shorePoints, stormOf, swellAt, swimAt } from '../src/play/living.ts';
import { bandCuts, cloneFill, facingOf, mirrorFill, rimPath } from '../src/scene/layers.ts';

test('a storm swells the sea more than a calm day, and a dry place is calm', () => {
  expect(stormOf(undefined)).toBe(0);
  const gale = stormOf({ fall: 'rain', strength: 0.85, wind: 0.6 });
  expect(gale).toBeGreaterThan(0.7);
  expect(stormOf({ fall: 'none', strength: 0, wind: 0 })).toBe(0);
  // Near rows heave far more than the far ones, and more in the gale.
  const heave = (u: number, storm: number) => Math.max(...Array.from({ length: 60 }, (_, k) => Math.abs(swellAt(300, u, k / 10, storm).dy)));
  expect(heave(1, gale)).toBeGreaterThan(8);
  expect(heave(0.05, gale)).toBeLessThan(3);
  expect(heave(1, gale)).toBeGreaterThan(heave(1, 0));
});

test('the waves roll toward the viewer: a crest moves down the rows as time goes on', () => {
  // Every crest along the rows at t, and the same crest a moment later: it has moved toward the viewer (down).
  const crests = (t: number) => {
    const at = (k: number) => swellAt(0, k / 1000, t, 0.5).crest;
    return Array.from({ length: 999 }, (_, k) => k + 1).filter((k) => at(k) > at(k - 1) && at(k) >= at(k + 1));
  };
  const before = crests(1).find((k) => k > 300)!;
  const after = crests(1.05).reduce((a, b) => (Math.abs(b - before) < Math.abs(a - before) ? b : a));
  expect(after).toBeGreaterThan(before);
});

test('surf breaks where the water meets the quay beside it, not along the horizon above it', () => {
  const [w, h] = [200, 120];
  const alpha = new Uint8Array(w * h);
  // Water everywhere below row 10, but the quay takes the left of it below row 60.
  for (let y = 10; y < h; y++) for (let x = 0; x < w; x++) alpha[y * w + x] = y >= 60 && x < 80 ? 0 : 255;
  const shore = shorePoints(alpha, w, h, 10);
  expect(shore.length).toBeGreaterThan(3);
  // Beside the quay (its right edge x 80, or its top row 60), never at the horizon row 10.
  expect(shore.every((p) => p.y > 30)).toBe(true);
  expect(shore.some((p) => p.x >= 80 && p.x < 92 && p.nx < 0)).toBe(true);
});

test('a fish swims back and forth, turning to face the way it goes, and now and then leaps', () => {
  let leaps = 0;
  for (let t = 0; t < 40; t += 0.05) {
    const s = swimAt(t, 1, 1, 80, 'water');
    const v = swimAt(t + 0.01, 1, 1, 80, 'water').dx - s.dx;
    // Facing right as painted: drawn as painted going right, flipped going left.
    if (Math.abs(v) > 0.05) expect(Math.sign(s.scaleX)).toBe(Math.sign(v));
    expect(Math.abs(s.dx)).toBeLessThanOrEqual(70);
    if (s.leap > 0) leaps++;
  }
  expect(leaps).toBeGreaterThan(0);
  expect(leapHeight(0.5, 40)).toBeGreaterThan(leapHeight(0.1, 40));
  // A bird never leaps out of the water.
  expect(Array.from({ length: 400 }, (_, k) => swimAt(k / 10, 2, -1, 60, 'air').leap).every((l) => l === 0)).toBe(true);
});

test('a cloud band is cut along its torn rim, a pixel up or down a column, never a notch', () => {
  const [W, H] = [120, 80];
  const edge = new Float32Array(W * H);
  // The rim runs from row 30 at the left down to row 42 at the right, with a stray bright fleck at row 55.
  for (let x = 0; x < W; x++) edge[(30 + Math.floor(x / 10)) * W + x] = 60;
  edge[55 * W + 60] = 500;
  const { path, strength } = rimPath(edge, W, 20, 60);
  expect(path[0]).toBe(30);
  expect(path[W - 1]).toBe(41);
  for (let x = 1; x < W; x++) expect(Math.abs(path[x] - path[x - 1])).toBeLessThanOrEqual(1);
  expect(strength).toBeGreaterThan(40);
});

test('bands are cut at the strongest rims, far enough apart', () => {
  const score = new Float32Array(400).fill(2);
  // Rims a few rows thick: two close together (the weaker one goes) and one further down.
  for (let k = -4; k <= 4; k++) [score[120 + k], score[134 + k], score[250 + k]] = [40, 38, 30];
  const cuts = bandCuts(score, 0, 360);
  expect(cuts.length).toBe(2);
  expect(Math.abs(cuts[0] - 122)).toBeLessThanOrEqual(6);
  expect(Math.abs(cuts[1] - 250)).toBeLessThanOrEqual(2);
});

const square = (W: number, H: number, x0: number, y0: number, x1: number, y1: number): Mask => {
  const m = emptyMask(W, H);
  for (let y = y0; y < y1; y++) m.bits.fill(1, y * W + x0, y * W + x1);
  return m;
};

test('a hole is filled with the paint beside it, not a blur: the stripes go on through it', () => {
  const [W, H] = [60, 20];
  const rgb = new Uint8Array(W * H * 3);
  // Vertical stripes 4 px wide, black and white.
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rgb.fill(Math.floor(x / 4) % 2 ? 255 : 0, (y * W + x) * 3, (y * W + x) * 3 + 3);
  const hole = square(W, H, 20, 5, 28, 15);
  const cloned = cloneFill(rgb, W, H, hole);
  const mirrored = mirrorFill(rgb, W, H, hole);
  for (const out of [cloned, mirrored]) {
    const values = new Set<number>();
    for (let y = 5; y < 15; y++) for (let x = 20; x < 28; x++) values.add(out[(y * W + x) * 3]);
    expect([...values].sort()).toEqual([0, 255]);
  }
});

test('a painted fish faces the way its eye is', () => {
  const [W, H] = [40, 20];
  const rgb = new Uint8Array(W * H * 3).fill(60);
  const body = square(W, H, 5, 5, 35, 15);
  // The white eye near the left end.
  for (const [x, y] of [[9, 8], [10, 8], [9, 9], [10, 9]]) rgb.fill(250, (y * W + x) * 3, (y * W + x) * 3 + 3);
  expect(facingOf(rgb, W, body)).toBe(-1);
  for (const [x, y] of [[9, 8], [10, 8], [9, 9], [10, 9]]) rgb.fill(60, (y * W + x) * 3, (y * W + x) * 3 + 3);
  for (const [x, y] of [[30, 8], [31, 8], [30, 9], [31, 9]]) rgb.fill(250, (y * W + x) * 3, (y * W + x) * 3 + 3);
  expect(facingOf(rgb, W, body)).toBe(1);
});
