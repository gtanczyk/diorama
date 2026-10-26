// The hero and every NPC as one painted figure each: Muse paints them alone on a plain ground, SAM cuts them out.
import sharp from 'sharp';
import type { Mask } from '../image/mask.ts';
import { maskBox } from '../image/raster.ts';
import type { Memo } from '../meta/memo.ts';
import { musePaint } from '../meta/muse.ts';
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

export async function paintFigure(memo: Memo, world: World, who: Who, take = 0): Promise<{ painting: Buffer; figure: Buffer }> {
  const painting = await musePaint(memo, { label: `figure:${who.key}`, prompt: figurePrompt(world, who), take });
  const png = await sharp(painting).png().toBuffer();
  const found = await samFind(memo, { label: `figure:${who.key}`, image: png, prompt: 'person' });
  if (!found.length) throw new Error(`${who.key}: SAM found no person in the painting; try --take 1`);
  const biggest = found.reduce((a, b) => (area(b.mask) > area(a.mask) ? b : a));
  return { painting: png, figure: await cutHero(png, biggest.mask) };
}

const area = (m: Mask) => m.bits.reduce((s, b) => s + b, 0);
