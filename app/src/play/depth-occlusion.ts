// depth-occlusion: the painting hides whoever stands behind it, also where nothing was masked. Things the
// story names get cards (geometry.occluders), but a painting is full of things nobody named: a lamp post,
// a railing, a bridge's parapet. The depth map (depth.png, src/scene/depthmap.ts) knows how far every pixel
// is, as the floor row at the same distance, so a pixel nearer than the person's feet stands in front of
// them and is put back over them. Cards stay in charge of their own pixels.
// No Node imports: the browser bundles this file.
import { stepAt, type Geometry } from './geometry.ts';
import { DEPTH_SCALE, type Depth } from './shadow.ts';

/** Floor rows the painting must be nearer than the feet by, at least, before it hides anyone: the depth model's noise. */
export const FRONT_MIN_ROWS = 6;
/** ... and as a share of the feet's own row (rows bunch up toward the horizon, metres don't). The depth model reads a wall right behind someone ~10% too near. */
export const FRONT_SHARE = 0.12;
/** How much the depth must grow per screen row under the feet for them to stand on a floor (1 on flat ground, ~0.3 up stairs, ~0 on a wall). */
export const FLOOR_SLOPE = 0.15;
/**
 * The most of a person's box the depth map may hide. Standing on visible floor, more than
 * this in front of them means the feet are really on what seems in front (a stair's riser, a slope the model
 * flattened): then it hides nothing, and the place's check (src/scene/occlusion-check.ts) lists the spot.
 */
export const MAX_HIDDEN = 0.75;

/** Within this many floor rows (or this share of the row) of the floor plane, a pixel is floor: where things stand. */
export const FLOOR_TOLERANCE = 6;
export const FLOOR_TOLERANCE_SHARE = 0.1;

const contacts = new WeakMap<Depth, Int16Array>();

/**
 * Per depth-map pixel, the frame row where what is painted there meets the floor: going down its column, the
 * first pixel no nearer than the floor plane at its own row. A lamp post meets it at its foot, a wall at its
 * base, a bridge's side where the water shows under it; a lamp's head where its post does. Only what meets the floor in front of someone's
 * feet can stand in front of them, whatever the depth model thinks of a wall behind them.
 */
export function contactRows(g: Pick<Geometry, 'scale'>, d: Depth): Int16Array {
  let out = contacts.get(d);
  if (out) return out;
  out = new Int16Array(d.w * d.h);
  for (let c = 0; c < d.w; c++) {
    let below = d.h * DEPTH_SCALE;
    for (let r = d.h - 1; r >= 0; r--) {
      const y = (r + 0.5) * DEPTH_SCALE;
      const flat = y - g.scale.horizonY;
      if (flat > 0 && d.rows[r * d.w + c] <= flat + Math.max(FLOOR_TOLERANCE, FLOOR_TOLERANCE_SHARE * flat)) below = Math.round(y);
      out[r * d.w + c] = below;
    }
  }
  // An overhang (a lamp's head wider than its post, a roof's eave) has nothing under its edge but what is behind:
  // along the row, what stands at the same distance shares the lowest foot it reaches.
  const standing = (i: number, y: number) => d.rows[i] > y - g.scale.horizonY + Math.max(FLOOR_TOLERANCE, FLOOR_TOLERANCE_SHARE * (y - g.scale.horizonY));
  const near = (a: number, b: number) => Math.abs(d.rows[a] - d.rows[b]) <= Math.max(2, 0.02 * d.rows[a]);
  for (let r = 0; r < d.h; r++) {
    const y = (r + 0.5) * DEPTH_SCALE;
    const at = r * d.w;
    for (let c = 1; c < d.w; c++) if (standing(at + c, y) && standing(at + c - 1, y) && near(at + c, at + c - 1)) out[at + c] = Math.max(out[at + c], out[at + c - 1]);
    for (let c = d.w - 2; c >= 0; c--) if (standing(at + c, y) && standing(at + c + 1, y) && near(at + c, at + c + 1)) out[at + c] = Math.max(out[at + c], out[at + c + 1]);
  }
  contacts.set(d, out);
  return out;
}

/** The depth map's floor row at a frame pixel (nearest sample). */
export function depthAt(d: Depth, x: number, y: number): number {
  const c = Math.min(d.w - 1, Math.max(0, Math.floor(x / DEPTH_SCALE)));
  const r = Math.min(d.h - 1, Math.max(0, Math.floor(y / DEPTH_SCALE)));
  return d.rows[r * d.w + c];
}

/**
 * How far the feet are, as a floor row below the horizon. On the floor that is their screen row. On a raised
 * floor (a deck, a step) the depth map says more, and the surface there still runs away from the camera:
 * the depth there wins. On an upright face (the side of a bridge a floor mask took in) the person is behind
 * that face, not on it: their screen row stays, so the face hides them.
 */
export function standRow(g: Pick<Geometry, 'scale' | 'steps'>, d: Depth, x: number, feetY: number): number {
  const row = feetY - g.scale.horizonY;
  // Stairs read from the painting (geometry.steps) are a raised floor by definition, risers and all.
  if (g.steps?.length && stepAt(g as Geometry, x, feetY)) return Math.max(row, depthAt(d, x, feetY - 1));
  // What is painted at the feet may stand in front of them (a post they are behind): that is not their floor.
  const c = Math.min(d.w - 1, Math.max(0, Math.floor(x / DEPTH_SCALE)));
  const r = Math.min(d.h - 1, Math.max(0, Math.floor((feetY - 1) / DEPTH_SCALE)));
  if (contactRows(g, d)[r * d.w + c] > feetY + 2) return row;
  return floorSlope(g, d, x, feetY) >= FLOOR_SLOPE ? Math.max(row, depthAt(d, x, feetY - 1)) : row;
}

/**
 * Depth gained per screen row over the ground just behind the feet: the least of a short look (a few px) and a
 * long one (a third of a person's height), so a low face with the sky just above it still reads as a face.
 */
export function floorSlope(g: Pick<Geometry, 'scale'>, d: Depth, x: number, feetY: number): number {
  const at = depthAt(d, x, feetY - 1);
  const slope = (span: number) => (at - depthAt(d, x, feetY - 1 - span)) / span;
  return Math.min(slope(4 * DEPTH_SCALE), slope(Math.max(12, 0.3 * g.scale.pxPerY * (feetY - g.scale.horizonY))));
}

/** Width of a person's box for a height (a standing figure's sheet is about this wide). */
export const PERSON_WIDTH = 0.36;

/** The share of a person's box, at (x, feetY), that the painting stands in front of where no card (`owned`) does. */
export function hiddenShare(g: Pick<Geometry, 'scale' | 'steps'>, d: Depth, x: number, feetY: number, owned?: Uint8Array): number {
  const h = Math.max(8, g.scale.pxPerY * (feetY - g.scale.horizonY));
  const half = Math.max(2, (PERSON_WIDTH * h) / 2);
  const limit = frontRow(standRow(g, d, x, feetY));
  const contact = contactRows(g, d);
  let hid = 0;
  let n = 0;
  for (let y = feetY - h; y < feetY - 2; y += DEPTH_SCALE) {
    const r = Math.min(d.h - 1, Math.max(0, Math.floor(y / DEPTH_SCALE)));
    for (let px = x - half; px <= x + half; px += DEPTH_SCALE) {
      const i = r * d.w + Math.min(d.w - 1, Math.max(0, Math.floor(px / DEPTH_SCALE)));
      if (owned?.[i]) continue;
      n++;
      if (d.rows[i] > limit && contact[i] > feetY + 2) hid++;
    }
  }
  return n ? hid / n : 0;
}

/** The floor row nearer than which the painting stands in front of feet at `stand`. */
export const frontRow = (stand: number) => stand + Math.max(FRONT_MIN_ROWS, FRONT_SHARE * stand);

/**
 * Pixels of the frame rect [x0, y0, x1, y1) (whole px) where the painting stands in front of someone whose
 * feet are at (x, feetY): 1 per pixel, row by row. `owned` (at the depth map's size) marks pixels a card
 * looks after; they are left to it. Null when nothing is in front.
 */
export function frontMask(g: Pick<Geometry, 'scale' | 'frame' | 'steps'>, d: Depth, rect: [number, number, number, number], x: number, feetY: number, owned?: Uint8Array): Uint8Array | null {
  const [x0, y0, x1, y1] = rect;
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return null;
  if (hiddenShare(g, d, x, feetY, owned) > MAX_HIDDEN) return null;
  const limit = frontRow(standRow(g, d, x, feetY));
  const contact = contactRows(g, d);
  const out = new Uint8Array(w * h);
  let any = false;
  for (let y = y0; y < y1; y++) {
    if (y < 0 || y >= g.frame.height) continue;
    const r = Math.min(d.h - 1, Math.floor(y / DEPTH_SCALE));
    for (let px = x0; px < x1; px++) {
      if (px < 0 || px >= g.frame.width) continue;
      const c = Math.min(d.w - 1, Math.floor(px / DEPTH_SCALE));
      const i = r * d.w + c;
      if (owned?.[i] || d.rows[i] <= limit || contact[i] <= feetY + 2) continue;
      out[(y - y0) * w + (px - x0)] = 1;
      any = true;
    }
  }
  return any ? out : null;
}
