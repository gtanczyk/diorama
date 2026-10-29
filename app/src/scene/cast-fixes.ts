// The person's fixes to the cast, kept in cast/fixes.json and applied by every rebuild: how a character
// looks (cast, model, sprites paint from it), which take to keep, and which voice speaks their lines.
import fs from 'node:fs';
import { z } from 'zod';
import type { WorldFiles } from '../world/files.ts';

export const CastFixes = z.record(z.string(), z.object({
  looks: z.string().min(10).optional(),
  take: z.number().int().min(0).optional(),
  /** The person asked for a 3D model (cast_animate) though the story would not build one: the model step builds it every time. */
  animate: z.boolean().optional(),
  voice: z.object({ voice: z.string().min(1), design: z.string().min(10).optional(), why: z.string().default('chosen by the person'), stability: z.number().min(0).max(1).optional(), style: z.number().min(0).max(1).optional() }).optional(),
  /** Rounds of walk and talk sheets asked for again (sprites_redo): each round paints new takes instead of the cached ones. */
  spriteTake: z.number().int().min(0).optional(),
  /** This character's own painting style over world.json's (style_set with scope cast). */
  style: z.string().min(10).optional(),
}));
export type CastFixes = z.infer<typeof CastFixes>;

export const castFixesFile = (files: WorldFiles) => files.path('cast', 'fixes.json');

export function readCastFixes(files: WorldFiles): CastFixes {
  const file = castFixesFile(files);
  return fs.existsSync(file) ? CastFixes.parse(files.readJson(file)) : {};
}

/** A character with the person's description in place of the world's. */
export function fixedLooks<T extends { key: string; looks: string }>(files: WorldFiles, who: T): T {
  const looks = readCastFixes(files)[who.key]?.looks;
  return looks ? { ...who, looks } : who;
}
