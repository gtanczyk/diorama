import { describe, expect, it } from 'vitest';
import { Geometry } from '../src/play/geometry.ts';
import { DEPTH_SCALE, type Depth } from '../src/play/shadow.ts';
import { frontMask, hiddenShare, standRow } from '../src/play/depth-occlusion.ts';
import { checkOcclusion, occlusionFindings } from '../src/scene/occlusion-check.ts';

const H0 = 200;
const g = Geometry.parse({
  frame: { width: 1200, height: 896 }, cell: 8, walk: ['#'], scale: { horizonY: H0, pxPerY: 0.5 }, start: [600, 700], things: [], occluders: [], depth: 'depth.png',
});

/** A flat floor below the horizon (each pixel its own row), far sky above, with things painted on it. */
function scene(paint: (x: number, y: number) => number | undefined): Depth {
  const [w, h] = [600, 448];
  const rows = new Float32Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const [x, y] = [c * DEPTH_SCALE + 1, r * DEPTH_SCALE + 1];
    rows[r * w + c] = paint(x, y) ?? Math.max(0.5, y - H0);
  }
  return { w, h, rows };
}

/** A lamp post: 12 px wide at x 600, standing on the floor at y 700, 300 px tall, with a 40 px head on top. */
const post = (x: number, y: number) => {
  const head = y >= 400 && y < 430 && Math.abs(x - 600) < 20;
  return head || (Math.abs(x - 600) < 6 && y >= 400 && y < 700) ? 700 - H0 : undefined;
};

const count = (m: Uint8Array | null) => (m ? m.reduce((a, b) => a + b, 0) : 0);
const box = (x: number, y: number): [number, number, number, number] => {
  const h = 0.5 * (y - H0);
  return [Math.round(x - 0.18 * h), Math.round(y - h), Math.round(x + 0.18 * h), y];
};

describe('depth occlusion', () => {
  it('a lamp post nobody named hides whoever stands behind it, not who stands in front', () => {
    const d = scene(post);
    // Far behind it, as in the alley: the post and its head are put back over him.
    expect(count(frontMask(g, d, box(600, 560), 600, 560))).toBeGreaterThan(200);
    // Head wider than the post: its edge, with only far ground under it, still stands in front.
    const m = frontMask(g, d, box(612, 560), 612, 560)!;
    expect(count(m)).toBeGreaterThan(0);
    // In front of it: nothing.
    expect(frontMask(g, d, box(600, 760), 600, 760)).toBeNull();
  });

  it('a wall right behind someone does not hide them, even when the depth model reads it a little near', () => {
    // A wall meeting the floor at y 500, read 9% nearer than it is.
    const d = scene((_, y) => (y < 500 ? 1.09 * (500 - H0) : undefined));
    expect(frontMask(g, d, box(600, 520), 600, 520)).toBeNull();
  });

  it('a bridge side a floor mask took in: people on it are drawn behind it, their top showing', () => {
    // An upright face from y 380 to 440 standing at the distance of floor row 460 (the far bank), sky above it.
    const d = scene((x, y) => (y >= 380 && y < 440 && x > 400 && x < 800 ? 460 - H0 : undefined));
    const feet = 425;
    expect(standRow(g, d, 600, feet)).toBe(feet - H0);
    const share = hiddenShare(g, d, 600, feet);
    expect(share).toBeGreaterThan(0.3);
    expect(share).toBeLessThan(0.75);
    const check = checkOcclusion({ ...g, cell: 8, walk: Array.from({ length: 112 }, (_, r) => (r * 8 >= 400 && r * 8 < 432 ? '.'.repeat(55) + '#'.repeat(40) + '.'.repeat(55) : '.'.repeat(150))) }, d);
    expect(check.onFace.length).toBeGreaterThan(0);
    expect(occlusionFindings(g, check).map((f) => f.code)).toContain('WALK_ON_FACE');
  });

  it('stairs read from the painting are a floor: their risers hide no one on them', () => {
    // Steps between y 400 and 600: each 20 px band's riser stands at the tread's distance.
    const d = scene((x, y) => (y >= 400 && y < 600 && x > 500 && x < 700 ? Math.ceil((y - 400) / 20) * 20 + 400 - H0 + 30 : undefined));
    const onStairs: Geometry = { ...g, steps: [{ x0: 500, every: 8, top: Array(26).fill(400), bottom: Array(26).fill(600) }] };
    expect(frontMask(onStairs, d, box(600, 500), 600, 500)).toBeNull();
  });

  it('no depth map: verify says only named things can hide anyone', () => {
    expect(occlusionFindings({ ...g, depth: undefined }, null).map((f) => f.code)).toEqual(['NO_DEPTH']);
  });
});
