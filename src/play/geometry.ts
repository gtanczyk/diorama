// geometry.json: what the game needs to know about a painted place to walk in it.
// derive writes it from the masks; the runtime only reads it. No Node imports: the browser bundles this file.
import { z } from 'zod';

const XY = z.tuple([z.number(), z.number()]);
const Box = z.tuple([z.number(), z.number(), z.number(), z.number()]).describe('x0, y0, x1, y1');

export const Geometry = z.object({
  frame: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  cell: z.number().int().positive(),
  /** Grid rows from the top; '#' is walkable, anything else is not. */
  walk: z.array(z.string()).min(1),
  /** Same shape as walk; a digit is the floor's index in layout order, '.' is no floor. */
  zone: z.array(z.string()).optional(),
  /** A 1.62 m person standing with feet at y is pxPerY * (y - horizonY) px tall. */
  scale: z.object({ horizonY: z.number(), pxPerY: z.number().positive(), source: z.enum(['spark', 'anchors', 'layout']).optional() }),
  start: XY,
  things: z.array(z.object({
    key: z.string(),
    role: z.enum(['prop', 'exit', 'item', 'npc']).optional(),
    kind: z.enum(['standing', 'wall', 'on-top', 'walk-on', 'flat']).optional(),
    box: Box,
    mask: z.string().optional().describe('path relative to the place folder; npcs have none'),
    stand: XY.describe('walkable spot to stand at when using it'),
    coarse: z.boolean().optional(),
    /** Where this thing was, painted empty (plates/<thing>.png: the patch only, transparent elsewhere), drawn once the story carries it off. */
    plate: z.string().optional(),
  })),
  /** One per connected blob of a thing's mask; it hides the mask's pixels inside its box. */
  occluders: z.array(z.object({
    key: z.string().describe('"barrel#1"'),
    thing: z.string().optional(),
    box: Box,
    mask: z.string().optional(),
    /** Always drawn over the hero (a framing tree, an arch). */
    front: z.boolean().optional(),
    baseY: z.number(),
    /** Where it meets the floor, per column, x ascending. Falls back to baseY. */
    floor: z.array(XY).optional(),
    /** Key of the occluder it sits on (a pot on a table): it hides exactly when that one does. */
    on: z.string().optional(),
    /** Floor footprint rows [x, back, front], for QA; derive already blocks those cells. */
    foot: z.array(z.tuple([z.number(), z.number(), z.number()])).optional(),
  })),
  /**
   * How the painting is lit, so people cast and catch shadows like the things around them.
   * dir: the way shadows fall across the floor in screen px (unit-ish; +x right, +y towards the viewer).
   * length: a shadow's floor length as a share of the caster's height (0.3 high sun, 1.5+ low sun).
   * strength: how dark painted shadows are, 0..1 (fog ~0.15, hard sun ~0.5). Omitted: no cast shadow.
   */
  light: z.object({ dir: XY, length: z.number().nonnegative(), strength: z.number().min(0).max(1) }).optional(),
  /** Mask (relative to the place folder) of painted shadows on floors: a person standing in one is darkened. */
  shadows: z.string().optional(),
  /**
   * Stair steps, top to bottom: each one's band (its tread and the riser below it) per column, sampled every
   * `every` px from x0 (-1 where the step doesn't reach). People's feet stay on a tread and step between them.
   */
  steps: z.array(z.object({ x0: z.number(), every: z.number().positive(), top: z.array(z.number()), bottom: z.array(z.number()) })).optional(),
  flagged: z.array(z.string()).optional(),
  /** Made from layout.json, not measured from the painting. */
  preview: z.boolean().optional(),
});
export type Geometry = z.infer<typeof Geometry>;
export type Occluder = Geometry['occluders'][number];
export type GeoThing = Geometry['things'][number];

/** A person's height in px with feet at y; never below a few px so far spots stay visible. */
export function personPx(g: Geometry, feetY: number): number {
  return Math.max(8, g.scale.pxPerY * (feetY - g.scale.horizonY));
}

/** The occluder's floor line at column x: interpolated, flat past either end, baseY without a line. */
export function floorYAt(o: Occluder, x: number): number {
  const line = o.floor;
  if (!line?.length) return o.baseY;
  if (x <= line[0][0]) return line[0][1];
  for (let i = 1; i < line.length; i++) {
    const [x1, y1] = line[i];
    if (x <= x1) {
      const [x0, y0] = line[i - 1];
      return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return line[line.length - 1][1];
}

/** Feet this close in front of a floor line still count as standing at it, not behind it. */
export const BEHIND_MARGIN = 6;

/** Whether the occluder hides a person whose feet are at feetY, in column x. `support` resolves `on`. */
export function hides(o: Occluder, x: number, feetY: number, support?: (key: string) => Occluder | undefined): boolean {
  if (o.front) return true;
  const under = o.on ? support?.(o.on) : undefined;
  if (under && under !== o) return hides(under, x, feetY);
  return feetY < floorYAt(o, x) - BEHIND_MARGIN;
}

/** Column runs [x0, x1) inside [left, right) where the occluder hides the person; a few runs per occluder. */
export function hiddenRuns(o: Occluder, left: number, right: number, feetY: number, support?: (key: string) => Occluder | undefined): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  const x0 = Math.max(Math.floor(left), Math.floor(o.box[0]));
  const x1 = Math.min(Math.ceil(right), Math.ceil(o.box[2]));
  let start = -1;
  for (let x = x0; x < x1; x++) {
    const hid = hides(o, x + 0.5, feetY, support);
    if (hid && start < 0) start = x;
    if (!hid && start >= 0) {
      runs.push([start, x]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start, x1]);
  return runs;
}

/** Where a tread puts the feet, as a share of the step's band from its top. */
const TREAD = 0.35;

/** The step bands [top, bottom] under column x, top first. */
export function stepBands(g: Geometry, x: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const s of g.steps ?? []) {
    const i = Math.round((x - s.x0) / s.every);
    if (i < 0 || i >= s.top.length || s.top[i] < 0 || s.bottom[i] <= s.top[i]) continue;
    out.push([s.top[i], s.bottom[i]]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** The step of g.steps a walker at (x, y) stands on, and how far down its band (0 top, 1 bottom). */
export function stepAt(g: Geometry, x: number, y: number): { step: number; at: number } | undefined {
  let best: { step: number; at: number } | undefined;
  (g.steps ?? []).forEach((s, step) => {
    const i = Math.round((x - s.x0) / s.every);
    if (i < 0 || i >= s.top.length || s.top[i] < 0 || s.bottom[i] <= s.top[i]) return;
    const at = (y - s.top[i]) / (s.bottom[i] - s.top[i]);
    // Neighbouring bands overlap a little: the one the walker is deeper inside wins.
    if (at >= 0 && at <= 1 && (!best || Math.abs(at - 0.5) < Math.abs(best.at - 0.5))) best = { step, at };
  });
  return best;
}

/** The y at column x that is `at` of the way down step `step`'s band; undefined where the step isn't. */
export function onStep(g: Geometry, step: number, x: number, at: number): number | undefined {
  const s = g.steps?.[step];
  const i = s ? Math.round((x - s.x0) / s.every) : -1;
  if (!s || i < 0 || i >= s.top.length || s.top[i] < 0 || s.bottom[i] <= s.top[i]) return undefined;
  return s.top[i] + at * (s.bottom[i] - s.top[i]);
}

/** Where feet stand on step `step` at column x: the same tread height stepFootY holds them at. */
export function treadY(g: Geometry, step: number, x: number): number | undefined {
  return onStep(g, step, x, TREAD);
}

const smooth = (u: number) => u * u * (3 - 2 * u);

/**
 * Where the feet are drawn for a walker at (x, y) on stairs: held on each tread, then a quick step over the
 * riser to the next, instead of gliding up a ramp. Off the stairs it is y. Size and depth still follow y.
 */
export function stepFootY(g: Geometry, x: number, y: number): number {
  const bands = stepBands(g, x);
  if (!bands.length || y <= bands[0][0] || y >= bands[bands.length - 1][1]) return y;
  // Control points (walker y -> foot y): flat on each tread's middle half, eased between.
  const pts: Array<[number, number]> = [[bands[0][0], bands[0][0]]];
  for (const [t, b] of bands) {
    const h = b - t;
    const foot = t + TREAD * h;
    const a = Math.max(t + 0.25 * h, pts[pts.length - 1][0]);
    pts.push([a, foot], [Math.max(a, b - 0.25 * h), foot]);
  }
  const last = bands[bands.length - 1][1];
  pts.push([last, last]);
  for (let k = 1; k < pts.length; k++) {
    const [y0, f0] = pts[k - 1];
    const [y1, f1] = pts[k];
    if (y > y1) continue;
    return y1 > y0 ? f0 + (f1 - f0) * smooth((y - y0) / (y1 - y0)) : f1;
  }
  return y;
}

/**
 * A walker's resting y on stairs: where it is when the feet stand on a tread, otherwise the next spot
 * ahead (`dir` -1 walking up the picture, 1 down) where they do, so nobody stops mid-step or steps back.
 */
export function stepRestY(g: Geometry, x: number, y: number, dir = 1): number {
  const flat = (v: number) => Math.abs(stepFootY(g, x, v + 1) - stepFootY(g, x, v - 1)) < 0.01;
  const bands = stepBands(g, x);
  if (!bands.length || flat(y)) return y;
  const step = dir < 0 ? -1 : 1;
  for (let v = y + step; v > bands[0][0] - 2 && v < bands[bands.length - 1][1] + 2; v += step) if (flat(v)) return v;
  return y;
}
