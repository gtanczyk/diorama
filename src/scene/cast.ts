// The hero and every NPC as one painted figure each: Muse paints them alone on a plain ground, SAM cuts them out.
import sharp from 'sharp';
import type { Mask } from '../image/mask.ts';
import { maskBox } from '../image/raster.ts';
import type { Memo } from '../meta/memo.ts';
import { museEdit, musePaint } from '../meta/muse.ts';
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

export async function paintFigure(memo: Memo, world: World, who: Who, take = 0, photo?: Buffer): Promise<{ painting: Buffer; figure: Buffer }> {
  const painting = photo
    ? await museEdit(memo, { label: `figure:${who.key}:photo`, prompt: photoPrompt(world), images: [await sharp(photo).rotate().png().toBuffer()], take })
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
