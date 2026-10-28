// The look of a world: world.json's style, a place's own (its corrections.json) or a character's own
// (cast/fixes.json) over it, and styled.json, the style each place and character was last painted in. When
// the style a picture should have differs from the one it was painted in, paint and cast repaint the picture
// they have in the new style with a Muse edit that keeps the composition, instead of painting anew: the
// masks, walk grid, stand spots and the person's fixes all keep lining up with it.
import fs from 'node:fs';
import { z } from 'zod';
import { readCastFixes } from '../scene/cast-fixes.ts';
import { readCorrections } from '../scene/corrections.ts';
import type { WorldFiles } from './files.ts';
import type { World } from './schema.ts';

export const Styled = z.object({
  places: z.record(z.string(), z.string()).default({}),
  cast: z.record(z.string(), z.string()).default({}),
  /** The world's style before it was first changed; set once, so sprite sheets know to name the new style. */
  from: z.string().optional(),
});
export type Styled = z.infer<typeof Styled>;

const file = (files: WorldFiles) => files.path('styled.json');

export function readStyled(files: WorldFiles): Styled {
  try {
    return Styled.parse(JSON.parse(fs.readFileSync(file(files), 'utf8')));
  } catch {
    return Styled.parse({});
  }
}

/** Records the style a place or character was just painted in. Read and written at once, so places painted side by side keep each other's. */
export function markStyled(files: WorldFiles, kind: 'places' | 'cast', key: string, style: string) {
  const styled = readStyled(files);
  if (styled[kind][key] === style) return;
  styled[kind][key] = style;
  files.write(file(files), styled);
}

export function writeStyled(files: WorldFiles, styled: Styled) {
  files.write(file(files), styled);
}

/** The style a place is painted in: its own when the person set one, else the world's. */
export function placeStyle(files: WorldFiles, world: World, place: string): string {
  return readCorrections(files.place(place)).style ?? world.style;
}

/** The style a character is painted in: their own when the person set one, else the world's. */
export function castStyle(files: WorldFiles, world: World, key: string): string {
  return readCastFixes(files)[key]?.style ?? world.style;
}
