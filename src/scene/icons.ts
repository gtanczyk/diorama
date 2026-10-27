// icons: a picture per inventory item, and only for the items the story has. An item the hero picks up in a
// place is cut out of that place's painting with the thing's SAM mask (no model call); one that is too small
// there, or that only a person hands over, is painted by Muse in the world's style and cut out by SAM.
import fs from 'node:fs';
import sharp from 'sharp';
import { z } from 'zod';
import { emptyMask, imageSize, maskArea, maskFromPng, maskToPng, type Mask } from '../image/mask.ts';
import { clampRect, components, maskBox } from '../image/raster.ts';
import type { Memo } from '../meta/memo.ts';
import { museEdit, musePaint } from '../meta/muse.ts';
import { samFind } from '../meta/sam.ts';
import type { Story } from '../story/schema.ts';
import type { WorldFiles } from '../world/files.ts';
import type { World } from '../world/schema.ts';

/** Icons are square, this many px a side; the item fills ICON_FILL of it. */
export const ICON_PX = 192;
const ICON_FILL = 168;
/** A cut-out whose longer side is shorter than this in the painting looks blurry blown up: Muse redraws it. */
export const MIN_CUT_PX = 56;

/** Where the hero gets each item: picked up from a thing in a place, or handed over (a talk, a use, a choice). */
export function itemSources(story: Story): Record<string, { place: string; thing: string } | null> {
  return Object.fromEntries(story.items.map((item) => {
    const take = story.interactions.find((it) => it.verb === 'take' && it.do.some((e) => 'give' in e && e.give === item.key));
    return [item.key, take ? { place: take.place, thing: take.thing } : null];
  }));
}

export const IconFixes = z.record(z.string(), z.object({
  /** cut: from the painting; paint: Muse draws it. Unset, the step decides. */
  how: z.enum(['cut', 'paint']).optional(),
  /** The person's words on how it should look, for Muse. */
  hint: z.string().min(3).optional(),
  take: z.number().int().min(0).optional(),
}));
export type IconFixes = z.infer<typeof IconFixes>;

export const iconFixesFile = (files: WorldFiles) => files.path('items', 'fixes.json');

export function readIconFixes(files: WorldFiles): IconFixes {
  const file = iconFixesFile(files);
  return fs.existsSync(file) ? IconFixes.parse(files.readJson(file)) : {};
}

export const ItemsInfo = z.record(z.string(), z.object({
  icon: z.string(),
  how: z.enum(['cut', 'redraw', 'paint']),
  from: z.object({ place: z.string(), thing: z.string() }).nullable(),
}));
export type ItemsInfo = z.infer<typeof ItemsInfo>;

/** The image inside `mask`, transparent elsewhere, trimmed and centred on a square icon. */
export async function cutIcon(image: Buffer, mask: Mask, pad = 3): Promise<Buffer> {
  const box = maskBox(mask);
  if (!box) throw new Error('empty mask');
  const [x0, y0, x1, y1] = clampRect([box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad], mask.width, mask.height);
  const alpha = await sharp(await maskToPng(mask)).blur(0.8).extractChannel(0).raw().toBuffer();
  const rgba = await sharp(image).resize(mask.width, mask.height, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
  for (let i = 0; i < mask.width * mask.height; i++) rgba[i * 4 + 3] = alpha[i];
  const piece = await sharp(rgba, { raw: { width: mask.width, height: mask.height, channels: 4 } })
    .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }).png().toBuffer();
  const fitted = await sharp(piece).resize(ICON_FILL, ICON_FILL, { fit: 'inside', kernel: 'lanczos3' }).png().toBuffer();
  return sharp({ create: { width: ICON_PX, height: ICON_PX, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: fitted, gravity: 'centre' }]).png().toBuffer();
}

/**
 * Cuts the item out of Muse's picture: SAM by its name, else as "object" (a name like "stale buns" may mean nothing to
 * it), else everything that stands out from the plain ground Muse was asked for, read from the picture's border.
 */
async function samCut(memo: Memo, label: string, picture: Buffer, phrase: string): Promise<Buffer> {
  for (const prompt of [phrase, 'object']) {
    const found = await samFind(memo, { label, image: picture, prompt });
    const best = found.sort((a, b) => maskArea(b.mask) - maskArea(a.mask))[0];
    if (best) return cutIcon(picture, best.mask);
  }
  const mask = await offGround(picture);
  if (!mask) throw new Error(`${label}: SAM did not find "${phrase}" on Muse's picture, and nothing stands out from its ground`);
  return cutIcon(picture, mask);
}

/** The largest blob whose colour differs from the picture's border (the plain ground), or null. */
export async function offGround(picture: Buffer): Promise<Mask | null> {
  const { data, info } = await sharp(picture).removeAlpha().resize(400, 400, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const border: number[][] = [[], [], []];
  for (let x = 0; x < w; x++) for (const y of [0, 1, h - 2, h - 1]) for (let c = 0; c < 3; c++) border[c].push(data[(y * w + x) * 3 + c]);
  for (let y = 0; y < h; y++) for (const x of [0, 1, w - 2, w - 1]) for (let c = 0; c < 3; c++) border[c].push(data[(y * w + x) * 3 + c]);
  const ground = border.map((v) => v.sort((a, b) => a - b)[v.length >> 1]);
  const small = emptyMask(w, h);
  for (let i = 0; i < w * h; i++) {
    const d = Math.hypot(data[i * 3] - ground[0], data[i * 3 + 1] - ground[1], data[i * 3 + 2] - ground[2]);
    if (d > 40) small.bits[i] = 1;
  }
  const blob = components(small).sort((a, b) => maskArea(b) - maskArea(a))[0];
  if (!blob || maskArea(blob) < w * h * 0.01) return null;
  const full = await imageSize(picture);
  return maskFromPng(await sharp(await maskToPng(blob)).resize(full.width, full.height, { fit: 'fill' }).png().toBuffer());
}

const look = (name: string, hint?: string) => (hint ? `${name} (${hint})` : name);

/** Muse redraws a small cut-out larger: same thing, same style, alone on a plain ground. */
export async function redrawIcon(memo: Memo, world: World, item: { key: string; name: string }, crop: Buffer, hint?: string, take = 0): Promise<Buffer> {
  const prompt = `This is a small ${item.name} cut from a painting. Paint the same ${look(item.name, hint)} large, whole and centred, alone on a plain flat pale background, `
    + `as an inventory icon for a point-and-click adventure game. Keep its shape, colours and details, in this style: ${world.style}. No hands, no people, no text, no frame.`;
  const picture = await museEdit(memo, { label: `icon:${item.key}:redraw`, prompt, images: [crop], take });
  return samCut(memo, `icon:${item.key}`, picture, item.name);
}

/** Muse paints an item nobody can see in any place. */
export async function paintIcon(memo: Memo, world: World, item: { key: string; name: string }, hint?: string, take = 0): Promise<Buffer> {
  const prompt = `A single ${look(item.name, hint)}, whole and centred, alone on a plain flat pale background, as an inventory icon for a point-and-click adventure game `
    + `set in "${world.title}". Style: ${world.style}. No hands, no people, no text, no frame.`;
  const picture = await musePaint(memo, { label: `icon:${item.key}:paint`, prompt, take });
  return samCut(memo, `icon:${item.key}`, picture, item.name);
}
