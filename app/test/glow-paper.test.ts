import { describe, expect, it } from 'vitest';
import { beamPaper, fillUnder, glowsOf, paperPose } from '../src/play/glow.ts';

const [W, H] = [400, 300];
const lamp = { x: 200, y: 100 };

/** A night sky (blue) with a white-hot lamp, and gold paper drawn by `lit`. */
function frame(lit: (x: number, y: number) => boolean): Uint8ClampedArray {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const hot = Math.hypot(x - lamp.x, y - lamp.y) < 10;
    px.set(hot ? [255, 250, 220, 255] : lit(x, y) ? [232, 196, 100, 255] : [30 + (x % 7), 50, 90, 255], (y * W + x) * 4);
  }
  return px;
}
const ray = (x: number, y: number, n: number) => {
  const r = Math.hypot(x - lamp.x, y - lamp.y);
  if (r < 30 || r > 180) return false;
  const a = ((Math.atan2(y - lamp.y, x - lamp.x) / (2 * Math.PI)) * n + n) % 1;
  return a < 0.12 || a > 0.88;
};

describe('lighthouse light paper', () => {
  it('lifts a burst of rays round the lamp, but not the lamp', () => {
    const p = beamPaper(frame((x, y) => ray(x, y, 16)), W, H, lamp)!;
    expect(p.burst).toBe(true);
    const [x0, y0] = p.box;
    const bw = p.box[2] - x0;
    expect(p.alpha[(lamp.y - y0) * bw + lamp.x - x0]).toBe(0);
    expect(p.alpha[(lamp.y - y0) * bw + lamp.x + 100 - x0]).toBeGreaterThan(0.9);
  });

  it('finds a beam reaching one way, and fills its hole with the sky round it', () => {
    const px = frame((x, y) => x < lamp.x - 15 && x > 20 && Math.abs(y - lamp.y) < 6 + (lamp.x - x) * 0.12);
    const p = beamPaper(px, W, H, lamp)!;
    expect(p.burst).toBe(false);
    expect(p.box[0]).toBeLessThan(25);
    const fill = fillUnder(px, W, lamp, p);
    const bw = p.box[2] - p.box[0];
    const o = ((lamp.y - p.box[1]) * bw + 100 - p.box[0]) * 4;
    // Sky blue where the gold was.
    expect(fill[o + 2]).toBeGreaterThan(fill[o]);
    expect(fill[o + 3]).toBe(255);
  });

  it('finds no paper round a lamp painted without any', () => {
    expect(beamPaper(frame(() => false), W, H, lamp)).toBeUndefined();
  });

  it('turns a burst to and fro, and runs a wave out along a beam', () => {
    const [g] = glowsOf([{ key: 'lighthouse-lamp', x: 0, y: 0, colour: '#ffe27a' }]);
    const turns = [0, 2, 4, 6].map((t) => paperPose(g, true, t).turn);
    expect(Math.max(...turns) - Math.min(...turns)).toBeGreaterThan(0.05);
    const waves = [0, 0.5, 1, 1.5, 2, 2.5].map((t) => paperPose(g, false, t).wave);
    expect(new Set(waves.map((w) => Math.round(w * 10))).size).toBeGreaterThan(3);
  });
});
