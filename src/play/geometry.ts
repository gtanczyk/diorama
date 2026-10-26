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
    /** The painting with this thing removed (plates/<thing>.png), drawn inside its mask once the story carries it off. */
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
