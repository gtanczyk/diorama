// stairs: the steps of a staircase, so people's feet stay on a tread and step over each riser instead
// of gliding up a ramp. Only places whose walk-on things or floors are stairs ask (one SAM call): SAM
// "stair step" returns one instance per step, tread and riser together, which is exactly the band a
// foot belongs to. Kept: wide, flat bands inside the stairs, at least two of them, stacked top to bottom.
import { emptyMask, maskArea, type Mask } from '../image/mask.ts';
import sharp from 'sharp';
import { dilate, intersect, maskBox, rectMask } from '../image/raster.ts';
import type { Memo } from '../meta/memo.ts';
import { samFind } from '../meta/sam.ts';
import type { Geometry } from '../play/geometry.ts';
import { FRAME } from './layout.ts';

const { width: W, height: H } = FRAME;
/** Column spacing of the stored step edges, px. */
export const STEP_EVERY = 8;

/** Words that make a floor or walk-on thing a staircase (English and Polish, as worlds are written in both). */
export const STAIRS = /stair|step|staircase|schod|stopn|stopień/i;

/** A mask at frame size (SAM may answer at the painting's own size). */
export function atFrame(m: Mask): Mask {
  if (m.width === W && m.height === H) return m;
  const out = emptyMask(W, H);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(m.height - 1, Math.floor((y * m.height) / H));
    for (let x = 0; x < W; x++) out.bits[y * W + x] = m.bits[sy * m.width + Math.min(m.width - 1, Math.floor((x * m.width) / W))];
  }
  return out;
}

/** One step's band per column: its first and last pixel, every STEP_EVERY px. */
export function stepEdges(m: Mask): NonNullable<Geometry['steps']>[number] | undefined {
  const box = maskBox(m);
  if (!box) return undefined;
  const x0 = Math.floor(box[0] / STEP_EVERY) * STEP_EVERY;
  const top: number[] = [];
  const bottom: number[] = [];
  for (let x = x0; x <= box[2]; x += STEP_EVERY) {
    let t = -1;
    let b = -1;
    for (let y = box[1]; y <= box[3] && y < H; y++) {
      if (!m.bits[y * W + Math.min(W - 1, x)]) continue;
      if (t < 0) t = y;
      b = y;
    }
    top.push(t);
    bottom.push(b);
  }
  return { x0, every: STEP_EVERY, top, bottom };
}

/** Least squares y = a + b x + c x² through the points, or undefined when there are too few. */
function quadratic(xs: number[], ys: number[]): ((x: number) => number) | undefined {
  if (xs.length < 4) return undefined;
  // Centred and scaled, so the normal equations stay well conditioned.
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const u = xs.map((x) => (x - m) / 100);
  const S = (f: (i: number) => number) => u.reduce((acc, _, i) => acc + f(i), 0);
  const [s0, s1, s2, s3, s4] = [0, 1, 2, 3, 4].map((k) => S((i) => u[i] ** k));
  const [t0, t1, t2] = [0, 1, 2].map((k) => S((i) => ys[i] * u[i] ** k));
  const det = (a: number[][]) => a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const A = [[s0, s1, s2], [s1, s2, s3], [s2, s3, s4]];
  const D = det(A);
  if (Math.abs(D) < 1e-9) return undefined;
  const col = (k: number) => det(A.map((row, r) => row.map((v, c) => (c === k ? [t0, t1, t2][r] : v))));
  const [a, b, c] = [col(0) / D, col(1) / D, col(2) / D];
  return (x: number) => { const v = (x - m) / 100; return a + b * v + c * v * v; };
}

/**
 * A step partly hidden by something on or in front of it (a basket on the tread, a boat at its end) is
 * mended: the back edge of a flight's step is a smooth line or arc, so columns far off that curve get the
 * curve instead, and a band much shallower than the step's usual depth gets its depth back.
 */
export function mendStep(s: NonNullable<Geometry['steps']>[number]): NonNullable<Geometry['steps']>[number] {
  const cols = s.top.flatMap((t, i) => (t >= 0 && s.bottom[i] > t ? [i] : []));
  const depths = cols.map((i) => s.bottom[i] - s.top[i]).sort((a, b) => a - b);
  if (!depths.length) return s;
  const usual = depths[Math.floor(depths.length / 2)];
  // Fit the back edge, dropping the worst columns until everything left lies close to it.
  let keep = cols;
  let curve = quadratic(keep.map((i) => i), keep.map((i) => s.top[i]));
  for (let round = 0; curve && round < 6; round++) {
    const fit = curve;
    const near = keep.filter((i) => Math.abs(s.top[i] - fit(i)) <= Math.max(6, 0.15 * usual));
    if (near.length === keep.length || near.length < 0.5 * cols.length) break;
    keep = near;
    curve = quadratic(keep.map((i) => i), keep.map((i) => s.top[i]));
  }
  const top = [...s.top];
  const bottom = [...s.bottom];
  for (const i of cols) {
    if (curve && Math.abs(top[i] - curve(i)) > Math.max(6, 0.15 * usual)) {
      top[i] = Math.round(curve(i));
      bottom[i] = Math.min(H - 1, top[i] + usual);
    } else if (bottom[i] - top[i] < 0.75 * usual) bottom[i] = Math.min(H - 1, top[i] + usual);
  }
  return { ...s, top, bottom };
}

/**
 * The steps of `stairs` read off the painting: a tread is lit from above, so its front edge is a row where the
 * picture turns from dark (the riser above's shadow) to light, all the way across the stairs. Rows like that,
 * evenly spaced, split the stairs into its steps, each from one tread's edge to the next. Empty when there is no
 * such run of at least three edges (a slope, a ladder, one big block): the stairs stay a ramp.
 */
export async function treadBands(painting: Buffer, stairs: Mask): Promise<Mask[]> {
  const box = maskBox(stairs);
  if (!box) return [];
  const L = await sharp(painting).resize(W, H, { fit: 'fill' }).greyscale().raw().toBuffer();
  // Per row: how much lighter the row below is than the row above, across the stairs' columns there.
  const rows: number[] = [];
  const width: number[] = [];
  for (let y = 0; y < H; y++) {
    if (y < box[1] + 2 || y > box[3] - 3) {
      rows.push(0);
      width.push(0);
      continue;
    }
    let n = 0;
    let sum = 0;
    for (let x = box[0]; x < box[2]; x++) {
      if (!stairs.bits[(y - 2) * W + x] || !stairs.bits[(y + 2) * W + x]) continue;
      n++;
      sum += L[(y + 1) * W + x] - L[(y - 1) * W + x];
    }
    rows.push(n ? sum / n : 0);
    width.push(n);
  }
  const widest = Math.max(...width);
  const edge = rows.map((v, y) => (y + 1 < H && Math.max(width[y], width[y + 1]) >= 0.4 * widest ? v + rows[y + 1] : 0));
  const strongest = Math.max(...edge);
  if (strongest < 40) return [];
  // Peaks: the lightest turn within 6 px either way, at least 60% of the strongest.
  const peaks = edge.flatMap((v, y) => (v >= 0.6 * strongest && edge.slice(Math.max(0, y - 6), y + 7).every((u, k) => u < v || (u === v && Math.max(0, y - 6) + k >= y)) ? [y] : []));
  if (peaks.length < 3) return [];
  const gaps = peaks.slice(1).map((y, i) => y - peaks[i]).sort((a, b) => a - b);
  const usual = gaps[Math.floor(gaps.length / 2)];
  if (usual < 8 || gaps.some((g) => g < 0.65 * usual || g > 1.5 * usual)) return [];
  // The top step's lit edge is the stairs' own top when there is a whole step above the first edge found.
  const cuts = [...(peaks[0] - box[1] >= 0.65 * usual ? [box[1]] : []), ...peaks, Math.min(box[3], peaks[peaks.length - 1] + usual)];
  return cuts.slice(1).map((y1, i) => intersect(stairs, rectMask(W, H, [box[0], cuts[i], box[2], y1]))).filter((m) => maskArea(m) > 0);
}

/**
 * The steps inside `stairs` (the walk-on things and floors named as stairs), top step first. Empty when
 * SAM finds no clear run of steps there: the stairs then stay a ramp, as before.
 */
export async function findSteps(memo: Memo, placeKey: string, painting: Buffer, stairs: Mask, log: (line: string) => void): Promise<NonNullable<Geometry['steps']>> {
  if (!maskArea(stairs)) return [];
  const found = await samFind(memo, { label: `steps:${placeKey}`, image: painting, prompt: 'stair step' });
  const region = dilate(stairs, 6);
  const bands: Mask[] = [];
  for (const f of found) {
    const m = atFrame(f.mask);
    const area = maskArea(m);
    const inside = intersect(m, region);
    const box = maskBox(inside);
    // A step is a wide, flat band, mostly inside the stairs.
    if (!box || maskArea(inside) < 0.6 * area || box[2] - box[0] < 1.5 * (box[3] - box[1])) continue;
    bands.push(inside);
  }
  if (bands.length < 2) {
    // SAM sees no single step on many painted stairs (a stack of cardboard boards, steps drawn in a few strokes):
    // the treads' lit edges, row after row, split the stairs instead.
    const lit = await treadBands(painting, stairs);
    if (lit.length < 2) {
      log(`stairs: ${bands.length} step(s) found, kept as a ramp`);
      return [];
    }
    log(`stairs: SAM found ${bands.length} step(s); ${lit.length} read off the treads' painted edges`);
    bands.length = 0;
    bands.push(...lit);
  }
  const steps = bands.map(stepEdges).filter((s): s is NonNullable<typeof s> => !!s).map(mendStep);
  const mid = (s: (typeof steps)[number]) => {
    const tops = s.top.filter((t) => t >= 0);
    return tops.reduce((a, b) => a + b, 0) / tops.length;
  };
  steps.sort((a, b) => mid(a) - mid(b));
  log(`stairs: ${steps.length} steps`);
  return steps;
}
