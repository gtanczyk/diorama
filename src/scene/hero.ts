// The hero as one painted figure: Muse paints them alone on a plain ground, SAM cuts them out.
import sharp from 'sharp';
import type { Mask } from '../image/mask.ts';
import { maskBox } from '../image/raster.ts';
import type { Memo } from '../meta/memo.ts';
import { musePaint } from '../meta/muse.ts';
import { samFind } from '../meta/sam.ts';
import type { World } from '../world/schema.ts';

export const HERO_PX = 600;

export function heroPrompt(world: World): string {
  return `A single full-body character for a 2D point-and-click adventure game, standing in a relaxed walking-ready pose, seen from the side in three-quarter view, facing to the right. The whole figure is visible from the top of the head down to both feet, centred, about two thirds of the image tall.

Character: ${world.hero.looks}
Style: ${world.style}

Plain flat light grey background, no floor, no shadow, no other people, no props around, no text.`;
}

/** The biggest instance SAM finds of the hero, as an RGBA PNG cropped to the figure and HERO_PX tall. */
export async function cutHero(painting: Buffer, mask: Mask): Promise<Buffer> {
  const box = maskBox(mask);
  if (!box) throw new Error('hero: the mask is empty');
  const [x0, y0, x1, y1] = box;
  const { data, info } = await sharp(painting).resize(mask.width, mask.height, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < mask.bits.length; i++) if (!mask.bits[i]) data[i * info.channels + 3] = 0;
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
    .resize({ height: HERO_PX })
    .png()
    .toBuffer();
}

export async function paintHero(memo: Memo, world: World, take = 0): Promise<{ painting: Buffer; figure: Buffer }> {
  const painting = await musePaint(memo, { label: `hero:${world.hero.key}`, prompt: heroPrompt(world), take });
  const png = await sharp(painting).png().toBuffer();
  const found = await samFind(memo, { label: `hero:${world.hero.key}`, image: png, prompt: 'person' });
  if (!found.length) throw new Error('hero: SAM found no person in the painting; try --take 1');
  const biggest = found.reduce((a, b) => (area(b.mask) > area(a.mask) ? b : a));
  return { painting: png, figure: await cutHero(png, biggest.mask) };
}

const area = (m: Mask) => m.bits.reduce((s, b) => s + b, 0);
