import { describe, expect, it } from 'vitest';
import { Geometry } from '../src/play/geometry.ts';
import { catchers, DEPTH_SCALE, shadowAt, sunFor, thingShadows, type Depth } from '../src/play/shadow.ts';
import { fitFloor } from '../src/scene/depthmap.ts';

const g = Geometry.parse({
  frame: { width: 1200, height: 896 }, cell: 8, walk: ['#'], scale: { horizonY: 200, pxPerY: 0.5 }, start: [600, 700], things: [], occluders: [],
});

/** A flat floor: every pixel below the horizon is the floor row it is on; `drop` lowers rows past `edge`. */
function floor(edge = Infinity, drop = 0): Depth {
  const [w, h] = [600, 448];
  const rows = new Float32Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const y = r * DEPTH_SCALE + 1 - 200;
    // A lower floor seen at the same screen row is farther: its depth reads as the floor row camH / (camH + drop) as low.
    rows[r * w + c] = y > 0 ? (r * DEPTH_SCALE >= edge ? y * (3.24 / (3.24 + drop)) : y) : 0.5;
  }
  return { w, h, rows };
}

/** A solid figure: a 1.62 m tall bar, broad enough to cover the depth rows near the feet. */
const bar = (px: number) => {
  const [w, h] = [Math.ceil(px) + 2, Math.ceil(px * 1.2)];
  const alpha = new Uint8ClampedArray(w * h);
  const [ox, oy] = [w / 2, Math.ceil(px * 1.1)];
  for (let y = oy - px; y < oy; y++) for (let x = ox - px / 4; x < ox + px / 4; x++) alpha[Math.round(y) * w + Math.round(x)] = 255;
  return { alpha, w, h, ox, oy, perM: px / 1.62 };
};

describe('ground shadow', () => {
  it('on a flat floor reaches as far as the painting says', () => {
    const [x, y] = [600, 700];
    const px = 0.5 * (y - 200);
    const light = { dir: [1, 0] as [number, number], length: 1, strength: 0.5 };
    const sun = sunFor(g, floor(), light, x, y, px)!;
    const sil = bar(px);
    const lit = (dx: number) => shadowAt(floor(), sun, sil, x + dx, y + 1);
    expect(lit(px * 0.5)).toBeGreaterThan(0);
    expect(lit(px * 0.95)).toBeGreaterThan(0);
    expect(lit(px * 1.1)).toBe(0);
    expect(lit(-px * 0.3)).toBe(0);
  });

  it('stops at a booth standing in its way and never shows on the floor behind it', () => {
    // A booth's face (x 450..650) stands on floor row 610; the person is just behind that line, right of it.
    const d = floor();
    for (let r = Math.floor(410 / DEPTH_SCALE); r < 610 / DEPTH_SCALE; r++) for (let c = 450 / DEPTH_SCALE; c < 650 / DEPTH_SCALE; c++) d.rows[r * d.w + c] = 410;
    const [x, y] = [800, 600];
    const px = 0.5 * (y - 200);
    const light = { dir: [-1, 0] as [number, number], length: 2.5, strength: 0.5 };
    const sil = bar(px);
    const behind = (dd: Depth) => shadowAt(dd, sunFor(g, dd, light, x, y, px)!, sil, 400, 600);
    expect(behind(floor())).toBeGreaterThan(0);
    expect(behind(d)).toBe(0);
    // Between the person and the booth it still lies on the floor.
    expect(shadowAt(d, sunFor(g, d, light, x, y, px)!, sil, 700, 601)).toBeGreaterThan(0);
  });

  it('lands on the floors and things, not on the fog or a ship in it', () => {
    // Above row 500 the depth model reads a fog bank as a wall; the floor zone ends there.
    const d = floor();
    for (let r = 0; r < 500 / DEPTH_SCALE; r++) for (let c = 0; c < d.w; c++) d.rows[r * d.w + c] = 300;
    const zoned = Geometry.parse({ ...g, zone: Array.from({ length: 112 }, (_, r) => (r * 8 >= 500 ? '0' : '.').repeat(150)) });
    const [x, y] = [600, 560];
    const px = 0.5 * (y - 200);
    const light = { dir: [0, -1] as [number, number], length: 2, strength: 0.5 };
    const sun = sunFor(g, d, light, x, y, px)!;
    const sil = bar(px);
    const count = (on?: Uint8Array) => {
      let n = 0;
      for (let yy = 300; yy < 500; yy += 2) n += shadowAt(d, sun, sil, x, yy, on) > 0 ? 1 : 0;
      return n;
    };
    expect(count()).toBeGreaterThan(0);
    expect(count(catchers(d, zoned))).toBe(0);
    // A thing standing there (its pixels, the owner map) still catches it.
    const owner = new Uint8Array(d.w * d.h).fill(1);
    expect(count(catchers(d, zoned, owner))).toBeGreaterThan(0);
  });

  it('runs longer down a drop', () => {
    const [x, y] = [600, 600];
    const px = 0.5 * (y - 200);
    const light = { dir: [0, 1] as [number, number], length: 0.6, strength: 0.5 };
    const flat = floor();
    const dropped = floor(640, 1);
    const sil = bar(px);
    const reach = (d: Depth) => {
      const sun = sunFor(g, d, light, x, y, px)!;
      let last = y;
      for (let yy = y; yy < 896; yy += 2) if (shadowAt(d, sun, sil, x, yy) > 0) last = yy;
      return last;
    };
    expect(reach(dropped)).toBeGreaterThan(reach(flat) + 10);
  });
});

describe('fitFloor', () => {
  it('finds the main floor among raised cells', () => {
    const samples: Array<[number, number]> = [];
    for (let y = 10; y < 600; y += 5) samples.push([y, 0.01 * y + 0.3]);
    for (let y = 10; y < 200; y += 5) samples.push([y, 0.02 * y + 0.3]);
    const fit = fitFloor(samples)!;
    expect(fit.a).toBeCloseTo(0.01, 3);
    expect(Math.abs(fit.b - 0.3)).toBeLessThan(0.1);
    expect(fit.inliers).toBeGreaterThan(0.6);
  });
});

describe('things in firelight', () => {
  it('a thing standing between the fire and the floor shades the floor behind it, not before it', () => {
    // A board 100 px (0.81 m) tall standing at frame row 600, x 560..640; the fire in front of it at row 680.
    const d = floor();
    const owner = new Uint8Array(d.w * d.h);
    for (let r = 500 / DEPTH_SCALE; r < 600 / DEPTH_SCALE; r++) for (let c = 560 / DEPTH_SCALE; c < 640 / DEPTH_SCALE; c++) {
      owner[r * d.w + c] = 1;
      d.rows[r * d.w + c] = 400;
    }
    const s = thingShadows(d, g, owner, [600, 680], { up: 1 });
    const at = (x: number, y: number) => s.alpha[Math.floor(y / DEPTH_SCALE / s.cell) * s.w + Math.floor(x / DEPTH_SCALE / s.cell)];
    expect(at(600, 490)).toBeGreaterThan(0);
    expect(at(600, 720)).toBe(0);
    expect(at(200, 490)).toBe(0);
    // A light higher than the board throws a shorter shadow: far behind it the floor is lit again.
    const high = thingShadows(d, g, owner, [600, 680], { up: 3 });
    expect(high.alpha[Math.floor(490 / DEPTH_SCALE / s.cell) * s.w + Math.floor(600 / DEPTH_SCALE / s.cell)]).toBe(0);
  });
});
