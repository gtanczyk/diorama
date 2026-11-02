// Parallax: a place drawn as a real diorama, a painted backdrop and cut-out cards standing on its floor.
// The floor is a plane, so how far a spot moves when the camera sways grows with its distance below the
// horizon; a card moves as the floor row it stands on. No Node imports: the browser bundles this file.
import type { Geometry, Occluder } from './geometry.ts';

/** How far (px) the bottom row moves against the horizon at a full camera swing. Kept small: a diorama, not a flyby. */
export const PARALLAX_PX = 22;
/** Vertical swing is half the horizontal one; eyes move sideways more than up and down. */
const VERTICAL = 0.5;

export type Camera = { x: number; y: number };

/** 0 at the horizon (and above it, the painted backdrop), 1 at the bottom of the frame. */
export function disparity(g: Geometry, y: number): number {
  const { horizonY } = g.scale;
  const span = Math.max(1, g.frame.height - horizonY);
  return Math.min(1.25, Math.max(0, (y - horizonY) / span));
}

/** The depth that stays put while the camera sways: the middle of the walkable floor, where the hero lives. */
export function pivot(g: Geometry): number {
  let sum = 0;
  let n = 0;
  g.walk.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) if (row[c] === '#') (sum += disparity(g, (r + 0.5) * g.cell)), n++;
  });
  return n ? sum / n : 0.5;
}

export type Parallax = { cam: Camera; pivot: number; px: number };

/** The shift of anything standing on the floor at feetY (its own pixels all move with it). */
export function shiftAt(g: Geometry, p: Parallax, feetY: number): [number, number] {
  const d = disparity(g, feetY) - p.pivot;
  return [p.cam.x * p.px * d, p.cam.y * p.px * VERTICAL * d];
}

/** The floor row a card stands on: its base, its support's for a thing on top, the frame's bottom for a framing one. */
export function cardY(g: Geometry, occ: Occluder, byKey: (key: string) => Occluder | undefined): number {
  if (occ.front) return g.frame.height;
  const under = occ.on ? byKey(occ.on) : undefined;
  return under && under !== occ ? under.baseY : occ.baseY;
}

/**
 * The backdrop's two pieces as canvas transforms [a, b, c, d, e, f] (x' = a x + c y + e, y' = b x + d y + f):
 * above the horizon it only slides; below, the floor shears, near rows sliding more than far ones.
 */
export function backdropTransforms(g: Geometry, p: Parallax): { above: number[]; below: number[] } {
  const h = g.scale.horizonY;
  const span = Math.max(1, g.frame.height - h);
  const kx = (p.cam.x * p.px) / span;
  const ky = (p.cam.y * p.px * VERTICAL) / span;
  const [ax, ay] = [-p.cam.x * p.px * p.pivot, -p.cam.y * p.px * VERTICAL * p.pivot];
  return { above: [1, 0, 0, 1, ax, ay], below: [1, 0, kx, 1 + ky, ax - kx * h, ay - ky * h] };
}

/** Where a point of the floor seen on screen at (x, y) lies in the painting. */
export function floorPoint(g: Geometry, p: Parallax, x: number, y: number): [number, number] {
  const { above, below } = backdropTransforms(g, p);
  let py = (y - below[5]) / below[3];
  if (py < g.scale.horizonY) py = y - above[5];
  const [dx] = py < g.scale.horizonY ? [above[4]] : [below[2] * py + below[4]];
  return [x - dx, py];
}

/** The zoom that keeps the frame's edges covered at a full swing in any direction. */
export function overscan(g: Geometry, p: Parallax): number {
  const reach = Math.max(p.pivot, disparity(g, g.frame.height) - p.pivot) * p.px;
  return 1 + Math.max((2 * reach) / g.frame.width, (2 * reach * VERTICAL) / g.frame.height);
}

/** Gaps up to this many px between stacked pieces of one thing are painted over by its card. */
export const STACK_GAP = 48;

/**
 * Cards for a parallax place: SAM often cuts one thing into pieces stacked in the same columns (a post's
 * cap and its foot, with the rope coil between them missed). Each such stack becomes one card, standing
 * where its lowest piece meets the floor; `stacked` marks cards whose gaps the runtime fills in.
 */
export function stackCards(occluders: Occluder[]): Array<Occluder & { stacked?: boolean }> {
  const out: Array<Occluder & { stacked?: boolean }> = occluders.map((o) => ({ ...o }));
  const overlap = (a: Occluder, b: Occluder) => Math.min(a.box[2], b.box[2]) - Math.max(a.box[0], b.box[0]);
  for (let merged = true; merged; ) {
    merged = false;
    for (const lo of out) {
      const up = out.find((u) => u !== lo && u.thing && u.thing === lo.thing && !u.front && !lo.front && !u.on && !lo.on
        && u.box[3] <= lo.box[1] + 4 && lo.box[1] - u.box[3] <= STACK_GAP
        && overlap(u, lo) > 0.5 * Math.min(u.box[2] - u.box[0], lo.box[2] - lo.box[0]));
      if (!up) continue;
      lo.box = [Math.min(lo.box[0], up.box[0]), up.box[1], Math.max(lo.box[2], up.box[2]), lo.box[3]];
      lo.stacked = true;
      out.splice(out.indexOf(up), 1);
      merged = true;
      break;
    }
  }
  return out;
}

/**
 * Per walk-grid column, the row where the walkable floor ends at the back (smoothed). The backdrop between
 * the horizon and that row is taken as standing upright there (a quay wall, a railing, the far side of a
 * room), so it slides as one piece with the floor's back edge instead of leaning with the floor's shear.
 */
export function backEdge(g: Geometry, smooth = 7): Float32Array {
  const cols = Math.max(...g.walk.map((r) => r.length));
  const raw = new Float32Array(cols).fill(NaN);
  for (let c = 0; c < cols; c++) {
    const r = g.walk.findIndex((row) => row[c] === '#');
    if (r >= 0) raw[c] = r * g.cell;
  }
  const valid = [...raw.keys()].filter((c) => !Number.isNaN(raw[c]));
  if (!valid.length) return raw.fill(g.scale.horizonY);
  for (let c = 0; c < cols; c++) {
    if (!Number.isNaN(raw[c])) continue;
    const near = valid.reduce((a, b) => (Math.abs(b - c) < Math.abs(a - c) ? b : a));
    raw[c] = raw[near];
  }
  // A wide moving average: neighbouring columns must slide by nearly the same amount, or the wall tears.
  const out = new Float32Array(cols);
  for (let c = 0; c < cols; c++) {
    let sum = 0;
    let n = 0;
    for (let d = -smooth; d <= smooth; d++) {
      const k = Math.min(cols - 1, Math.max(0, c + d));
      sum += raw[k];
      n++;
    }
    out[c] = Math.max(g.scale.horizonY, sum / n);
  }
  return out;
}

/** The far view as flats: the sky (drawn still) and flats farthest first, each a cut-out at `box` in the frame. */
export type Layers = {
  sky: string | null;
  flats: Array<{ file: string; box: [number, number, number, number] }>;
  /** Water to set flowing: an opaque texture over `box` (carried past the banks), its soft mask, and which way it runs on screen (unit vector; [0, 0] still; left to right when missing). */
  water?: { tex: string; mask: string; box: [number, number, number, number]; flow?: [number, number] };
  /** Painted fog to set drifting: a soft copy over `box` (carried past its edges), its mask, which way (-1 left, 1 right, null with the wind) and how fast. */
  mist?: { tex: string; mask: string; box: [number, number, number, number]; drift?: -1 | 0 | 1 | null; speed?: number };
  /** Painted smoke to set curling: each plume a feathered copy of the painting over `box`. */
  smoke?: Array<{ file: string; box: [number, number, number, number] }>;
  /** Boats painted on the water (not cards), each a feathered copy of the painting over `box`, to rock on the swell. */
  floats?: Array<{ file: string; box: [number, number, number, number] }>;
};

/**
 * How far each far flat slides, as a disparity: spread evenly between the horizon (the sky, still) and the
 * nearest upright band, so each flat sits clearly behind the next. Stage flats, not measured distances.
 */
export function flatDisparities(g: Geometry, edge: Float32Array, count: number): number[] {
  const nearest = Math.max(0.2, disparity(g, Math.min(...edge)));
  return Array.from({ length: count }, (_, k) => (0.85 * nearest * (k + 1)) / (count + 1));
}

/**
 * The far flats left to draw once boats rock: a flat cut around the same boat as a float (most of its box
 * inside the float's) would stay still under it, so the eye sees the painted boat stand and only a ghost
 * of its edges move. The float carries the boat; the sky under it already has the boat painted out.
 */
export function flatsUnderFloats<F extends { box: [number, number, number, number] }>(
  flats: F[], floats: Array<{ box: [number, number, number, number] }> | undefined,
): F[] {
  if (!floats?.length) return flats;
  const area = (b: number[]) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const inside = (a: number[], b: number[]) =>
    area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]) / Math.max(1, area(a));
  return flats.filter((f) => !floats.some((fl) => inside(f.box, fl.box) > 0.6));
}

/** The shift of something at disparity d (see shiftAt, which takes a floor row). */
export function shiftAtDisparity(p: Parallax, d: number): [number, number] {
  return [p.cam.x * p.px * (d - p.pivot), p.cam.y * p.px * VERTICAL * (d - p.pivot)];
}
