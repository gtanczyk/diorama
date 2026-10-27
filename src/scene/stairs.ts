// stairs: the steps of a staircase, so people's feet stay on a tread and step over each riser instead
// of gliding up a ramp. Only places whose walk-on things or floors are stairs ask (one SAM call): SAM
// "stair step" returns one instance per step, tread and riser together, which is exactly the band a
// foot belongs to. Kept: wide, flat bands inside the stairs, at least two of them, stacked top to bottom.
import { emptyMask, maskArea, type Mask } from '../image/mask.ts';
import { dilate, intersect, maskBox } from '../image/raster.ts';
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
function atFrame(m: Mask): Mask {
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
    log(`stairs: ${bands.length} step(s) found, kept as a ramp`);
    return [];
  }
  const steps = bands.map(stepEdges).filter((s): s is NonNullable<typeof s> => !!s);
  const mid = (s: (typeof steps)[number]) => {
    const tops = s.top.filter((t) => t >= 0);
    return tops.reduce((a, b) => a + b, 0) / tops.length;
  };
  steps.sort((a, b) => mid(a) - mid(b));
  log(`stairs: ${steps.length} steps`);
  return steps;
}
