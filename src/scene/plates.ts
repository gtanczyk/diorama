// plates: for things the hero carries off, the painting with the thing gone. Muse repaints the
// whole picture on an edit, so only the thing's mask (grown a little, feathered) is taken from it.
// SAM then looks for the thing again on the plate: if it is still there, the plate is flagged.
import sharp from 'sharp';
import { maskArea, maskToPng, type Mask } from '../image/mask.ts';
import { dilate, intersect, maskIou } from '../image/raster.ts';
import type { Memo } from '../meta/memo.ts';
import { museEdit } from '../meta/muse.ts';
import { samFind } from '../meta/sam.ts';
import type { Place } from '../world/schema.ts';
import { FRAME } from './layout.ts';

export const PLATE_GROW = 12;

/** Pastes `patch` over `painting` inside `mask`, with a soft edge. */
export async function pasteInside(painting: Buffer, patch: Buffer, mask: Mask, feather = 4): Promise<Buffer> {
  const { width: W, height: H } = FRAME;
  const alpha = await sharp(await maskToPng(mask)).blur(feather).toColourspace('b-w').raw().toBuffer();
  const cut = await sharp(patch).resize(W, H, { fit: 'fill' }).removeAlpha().joinChannel(alpha, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
  return sharp(painting).resize(W, H, { fit: 'fill' }).composite([{ input: cut }]).png().toBuffer();
}

export type Plate = { thing: string; png: Buffer; stillThere: boolean; iou: number };

export async function plateFor(memo: Memo, place: Place, thing: { key: string; phrase: string; mask: Mask }, painting: Buffer, ground: string): Promise<Plate> {
  const prompt = `Remove the ${thing.phrase} from this painting. Paint ${ground} where it was, continuing the surroundings, in the same style and light. Leave everything else exactly as it is. No people, no text.`;
  const edited = await museEdit(memo, { label: `plate:${place.key}/${thing.key}`, prompt, images: [painting] });
  const area = dilate(thing.mask, PLATE_GROW);
  const png = await pasteInside(painting, edited, area);
  // Is it still there? SAM by the same phrase, inside the area the plate replaced.
  const found = await samFind(memo, { label: `plate-check:${place.key}/${thing.key}`, image: png, prompt: thing.phrase });
  const iou = Math.max(0, ...found.map((f) => maskIou(intersect(f.mask, area), thing.mask)));
  const left = found.reduce((px, f) => px + maskArea(intersect(f.mask, thing.mask)), 0);
  return { thing: thing.key, png, iou, stillThere: iou > 0.4 || left > 0.4 * maskArea(thing.mask) };
}
