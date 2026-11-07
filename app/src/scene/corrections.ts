// The person's fixes to a place, kept in places/<place>/corrections.json and applied again by every
// rebuild: paint repaints their regions, masks takes their names, boxes, kinds, floor cells and
// brush strokes, derive their stand spots. A fix is never an edit to a generated file, which the
// next build would overwrite.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { maskArea, type Mask } from '../image/mask.ts';
import { clampRect, maskBox, type Rect } from '../image/raster.ts';
import { FRAME } from './layout.ts';
import { KINDS, type Spots } from './locate.ts';

const XY = z.tuple([z.number(), z.number()]);
export const RectIn = z.tuple([z.number(), z.number(), z.number(), z.number()]).describe('x0, y0, x1, y1 in painting pixels (1200x896)');

export const Stroke = z.object({
  mode: z.enum(['add', 'erase']),
  radius: z.number().min(1).max(200),
  points: z.array(XY).min(1).max(2000),
});
export type Stroke = z.infer<typeof Stroke>;

export const Corrections = z.object({
  /** Persistent instructions for repairing an unfinished layout. */
  layout: z.object({
    guidance: z.string().min(10).max(4000),
    /** layout_fix rounds after a composition rejection since the last new painting take. */
    replans: z.number().int().min(0).optional(),
  }).optional(),
  things: z.record(z.string(), z.object({
    /** What to ask SAM for instead of Spark's phrase. */
    phrase: z.string().min(2).optional(),
    /** Where it really is, instead of Spark's box. */
    box: RectIn.optional(),
    /** How it meets the floor, instead of Spark's reading. */
    kind: z.enum(KINDS).optional(),
    strokes: z.array(Stroke).default([]),
    /** Where the hero stands to use it. */
    stand: XY.optional(),
    /** Where an NPC stands (its feet), instead of the layout's spot. */
    at: XY.optional(),
    /** Not a thing of its own any more (a prop the person took off the list): it stays painted, or is painted out. */
    removed: z.boolean().optional(),
  })).default({}),
  /** Props the person added to the place's things, by key: what it is, in words (it must be in the painting). */
  added: z.record(z.string(), z.object({ looks: z.string().min(3) })).default({}),
  floors: z.record(z.string(), z.object({
    add: z.array(z.string()).default([]),
    remove: z.array(z.string()).default([]),
    strokes: z.array(Stroke).default([]),
  })).default({}),
  repaint: z.array(z.object({ region: RectIn, fix: z.string().min(3) })).default([]),
  /**
   * How the place is worded for the painter, instead of world.json and Spark's brief: set by paint_words, or by
   * paint itself when the image safety filter refused the painting and Spark reworded it.
   */
  words: z.object({
    shows: z.string().min(10).optional(),
    mood: z.string().min(2).optional(),
    /** One sentence per thing or floor key, used as its look as it is (Spark does not expand it again). */
    looks: z.record(z.string(), z.string().min(10)).default({}),
    by: z.enum(['filter', 'person']).default('person'),
    /** Spark's rewords so far: each asks anew, so a rebuild after refused rewords does not get the same words back. */
    tries: z.number().int().min(0).optional(),
  }).optional(),
  /** Which take of the painting (paint --take): the build asks for a new one when the painting left the layout (FLOOR_LOST). */
  take: z.number().int().min(0).optional(),
  /** Where the hero begins in this place (hero_start_set), instead of the front middle of the biggest floor. */
  start: XY.optional(),
  /**
   * How tall the hero stands here, against a thing painted in this place (hero_size_set): `times` that thing's painted
   * height. The place's scale is set from it, over Spark's guess of a person. One world's places can come out ten
   * times apart (a desk seen whole, people-sized, and a close-up of a mug, props-sized), and the hero with them.
   */
  heroSize: z.object({ like: z.string().min(1), times: z.number().positive().max(20) }).optional(),
  /** This place's own painting style over world.json's (style_set with scope place). */
  style: z.string().min(10).optional(),
});
export type Corrections = z.infer<typeof Corrections>;

export const correctionsFile = (placeDir: string) => path.join(placeDir, 'corrections.json');

export function readCorrections(placeDir: string): Corrections {
  const file = correctionsFile(placeDir);
  if (!fs.existsSync(file)) return Corrections.parse({});
  return Corrections.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function writeCorrections(placeDir: string, c: Corrections) {
  fs.writeFileSync(correctionsFile(placeDir), `${JSON.stringify(c, null, 2)}\n`);
}

/** Spark's spots with the person's names, boxes and kinds in their place. */
export function correctSpots(spots: Spots, c: Corrections): Spots {
  const out: Spots = { ...spots };
  for (const [key, fix] of Object.entries(c.things)) {
    const spot = out[key];
    if (!spot) continue;
    out[key] = {
      ...spot,
      ...(fix.phrase && { phrase: fix.phrase, also: undefined }),
      ...(fix.box && { box: clampRect(fix.box, FRAME.width, FRAME.height) }),
      ...(fix.kind && { kind: fix.kind }),
    };
  }
  return out;
}

/** Spark's floor cells with the person's added and removed. */
export function correctCells(marked: Record<string, string[]>, c: Corrections): Record<string, string[]> {
  return Object.fromEntries(Object.entries(marked).map(([key, cells]) => {
    const fix = c.floors[key];
    if (!fix) return [key, cells];
    const removed = new Set(fix.remove.map((s) => s.toUpperCase()));
    return [key, [...new Set([...cells, ...fix.add.map((s) => s.toUpperCase())])].filter((s) => !removed.has(s))];
  }));
}

/** Paints brush strokes into a mask: round dabs along each line, added or erased. */
export function brush(mask: Mask, strokes: Stroke[]): Mask {
  if (strokes.length === 0) return mask;
  const out: Mask = { ...mask, bits: mask.bits.slice() };
  const { width: W, height: H } = out;
  for (const s of strokes) {
    const v = s.mode === 'add' ? 1 : 0;
    const r = s.radius;
    const dab = (cx: number, cy: number) => {
      for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(H - 1, Math.ceil(cy + r)); y++) {
        for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(W - 1, Math.ceil(cx + r)); x++) {
          if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) out.bits[y * W + x] = v;
        }
      }
    };
    s.points.forEach(([x, y], i) => {
      const [px, py] = i ? s.points[i - 1] : [x, y];
      const n = Math.max(1, Math.ceil(Math.hypot(x - px, y - py) / Math.max(1, r / 2)));
      for (let k = 1; k <= n; k++) dab(px + ((x - px) * k) / n, py + ((y - py) * k) / n);
    });
  }
  return out;
}

/** A mask after the person's strokes, with its size and box measured again. */
export function brushed<T extends { mask: Mask; px: number }>(m: T, strokes: Stroke[] | undefined): T & { brushed?: true } {
  if (!strokes?.length) return m;
  const mask = brush(m.mask, strokes);
  const box = maskBox(mask) ?? ([0, 0, 0, 0] as Rect);
  return { ...m, mask, px: maskArea(mask), ...('box' in m && { box }), brushed: true };
}

export const isEmpty = (c: Corrections) => Object.keys(c.things).length === 0 && Object.keys(c.floors).length === 0 && c.repaint.length === 0;


/**
 * The layout with each moved NPC standing where the person put it: feet at the new spot, and as much bigger or
 * smaller as the depth there asks (height grows with the distance below the horizon).
 */
export function placeNpcs<L extends { horizon: number; things: Array<{ key: string; x: number; footY: number; width: number; height: number }> }>(layout: L, npcs: ReadonlySet<string>, c: Corrections): L {
  return {
    ...layout,
    things: layout.things.map((t) => {
      const at = npcs.has(t.key) ? c.things[t.key]?.at : undefined;
      if (!at) return t;
      const before = t.footY - layout.horizon;
      const after = at[1] - layout.horizon;
      const k = before > 0 && after > 0 ? after / before : 1;
      return { ...t, x: at[0], footY: at[1], width: t.width * k, height: t.height * k };
    }),
  };
}
