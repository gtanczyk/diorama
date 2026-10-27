// The hero and every NPC as one painted figure each: Muse paints them alone on a plain ground, SAM cuts them out.
import sharp from 'sharp';
import type { Mask } from '../image/mask.ts';
import { maskBox } from '../image/raster.ts';
import type { Memo } from '../meta/memo.ts';
import { museEdit, musePaint } from '../meta/muse.ts';
import { askSparkJson } from '../meta/spark.ts';
import { samFind } from '../meta/sam.ts';
import type { World } from '../world/schema.ts';

export const HERO_PX = 600;

export type Who = { key: string; looks: string };

export function figurePrompt(world: World, who: Who): string {
  return `A single full-body character for a 2D point-and-click adventure game, standing in a relaxed walking-ready pose, seen from the side in three-quarter view, facing to the right. The whole figure is visible from the top of the head down to both feet, centred, about two thirds of the image tall.

Character: ${who.looks}
Style: ${world.style}

Plain flat light grey background, no floor, no shadow, no other people, no props around, no text.`;
}

/** The biggest instance SAM finds of the hero, as an RGBA PNG cropped to the figure and HERO_PX tall. */
export async function cutHero(painting: Buffer, mask: Mask): Promise<Buffer> {
  const box = maskBox(mask);
  if (!box) throw new Error('figure: the mask is empty');
  const [x0, y0, x1, y1] = box;
  const { data, info } = await sharp(painting).resize(mask.width, mask.height, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < mask.bits.length; i++) if (!mask.bits[i]) data[i * info.channels + 3] = 0;
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
    .resize({ height: HERO_PX })
    .png()
    .toBuffer();
}

/** For a photo of a real person: same person, same pose and outline, so live footage can dissolve into the figure. */
export function photoPrompt(world: World): string {
  return `Repaint this photo of a person as a character of a 2D point-and-click adventure game. Keep the same person, face, hair, clothes, body proportions and exact pose, at the same place and size in the frame, so the outline matches the photo. Show the whole figure from head to feet.

Style: ${world.style}

Plain flat light grey background, no floor, no shadow, no other people, no text.`;
}

/** For a child's drawing: the character they drew, as they drew it, made whole enough to walk. */
export function drawingPrompt(world: World, who: Who): string {
  return `This is a child's drawing on paper. Paint the character in it as a single full-body character for a 2D point-and-click adventure game, so the child who drew it knows it at once: the same colours, the same clothes and features, the same shapes and proportions (a big head stays big), only cleaner and whole. Standing in a relaxed walking-ready pose, seen from the side in three-quarter view, facing to the right, the whole figure visible from the top of the head down to both feet (or paws), centred, about two thirds of the image tall.

Character: ${who.looks}
Style: ${world.style}

Plain flat light grey background, no paper, no table, no written name, no floor, no shadow, no other characters, no text.`;
}

/** `from` is a photo of a real person, or a child's drawing of the character. */
export async function paintFigure(memo: Memo, world: World, who: Who, take = 0, from?: { photo?: Buffer; drawing?: Buffer }): Promise<{ painting: Buffer; figure: Buffer }> {
  const painting = from?.photo
    ? await museEdit(memo, { label: `figure:${who.key}:photo`, prompt: photoPrompt(world), images: [await sharp(from.photo).rotate().png().toBuffer()], take })
    : from?.drawing
      ? await museEdit(memo, { label: `figure:${who.key}:drawing`, prompt: drawingPrompt(world, who), images: [from.drawing], take })
      : await musePaint(memo, { label: `figure:${who.key}`, prompt: figurePrompt(world, who), take });
  const png = await sharp(painting).png().toBuffer();
  // Not every character is a person (a flock of pigeons, a cat): SAM is asked by their own description next.
  let found: Awaited<ReturnType<typeof samFind>> = [];
  for (const prompt of ['person', who.looks.split(/[,.;]/)[0].trim().split(/\s+/).slice(0, 6).join(' '), 'animal']) {
    found = await samFind(memo, { label: `figure:${who.key}`, image: png, prompt });
    if (found.length) break;
  }
  if (!found.length) throw new Error(`${who.key}: SAM found no one in the painting; try another take (cast_redo anotherTake)`);
  const biggest = found.reduce((a, b) => (area(b.mask) > area(a.mask) ? b : a));
  return { painting: png, figure: await cutHero(png, biggest.mask) };
}

const area = (m: Mask) => m.bits.reduce((s, b) => s + b, 0);

/** A grown-up's height, the scale's unit (PERSON_M in src/scene/scale.ts). */
export const PERSON_M = 1.62;

/**
 * How tall each character stands, in metres (a cat about 0.3, a child about 1.1, a grown-up 1.62), so the
 * runtime draws an animal or a child at its own size, not as a person-sized cut-out. One Spark call for the cast.
 */
export async function castHeights(memo: Memo, world: World, cast: Who[]): Promise<Record<string, number>> {
  if (!cast.length) return {};
  const prompt = `These are the characters of a 2D adventure game (${world.pitch}):
${cast.map((w) => `- ${w.key}: ${w.looks}`).join('\n')}
How tall does each one stand, in metres, from the ground to the top of the head (for an animal on four legs, to the top of its head as it stands)? An ordinary grown-up is ${PERSON_M}.
Reply with JSON only: {${cast.map((w) => `"${w.key}": <metres>`).join(', ')}}`;
  const a = await askSparkJson<Record<string, unknown>>(memo, { label: 'cast-heights', prompt });
  return Object.fromEntries(cast.flatMap((w) => {
    const m = Number(a[w.key]);
    return Number.isFinite(m) && m > 0 ? [[w.key, Math.round(Math.min(3, Math.max(0.08, m)) * 100) / 100]] : [];
  }));
}
