// backdrop: the painting with every card (each sharp standing thing) taken out, for parallax. When the
// cards slide against the floor, a few px of what is behind them show; Muse paints what is there.
// Muse repaints the whole picture on an edit, so only the cards' masks (grown, feathered) are taken from it.
// A card SAM still finds on the backdrop gets a smeared fill of its surroundings instead: blurry beats a ghost.
import sharp from 'sharp';
import { maskArea, type Mask } from '../image/mask.ts';
import { dilate, intersect, maskIou, unionAll } from '../image/raster.ts';
import type { Memo } from '../meta/memo.ts';
import { museEdit } from '../meta/muse.ts';
import { samFind } from '../meta/sam.ts';
import type { Place } from '../world/schema.ts';
import { FRAME } from './layout.ts';
import { pasteInside } from './plates.ts';

/** Far more than a card ever slides against the backdrop behind it (see PARALLAX_PX). */
export const BACKDROP_GROW = 14;

/**
 * Fills the masked pixels from their surroundings: a pyramid of averages of the known pixels,
 * read back from the finest level that has any. Smooth, never sharp; fine for a strip of a few px.
 * With `known`, only those pixels feed the fill.
 */
export function smearFill(rgb: Uint8Array, W: number, H: number, hole: Mask, known?: Mask): Uint8Array {
  type Level = { w: number; h: number; sum: Float32Array; weight: Float32Array };
  const base: Level = { w: W, h: H, sum: new Float32Array(W * H * 3), weight: new Float32Array(W * H) };
  for (let i = 0; i < W * H; i++) {
    // Known pixels: everything outside the hole, or only `known` (to grow a layer from its own pixels).
    if (known ? !known.bits[i] : hole.bits[i]) continue;
    base.weight[i] = 1;
    for (let c = 0; c < 3; c++) base.sum[i * 3 + c] = rgb[i * 3 + c];
  }
  const levels = [base];
  while (levels.at(-1)!.w > 1 || levels.at(-1)!.h > 1) {
    const f = levels.at(-1)!;
    const w = Math.max(1, Math.ceil(f.w / 2));
    const h = Math.max(1, Math.ceil(f.h / 2));
    const next: Level = { w, h, sum: new Float32Array(w * h * 3), weight: new Float32Array(w * h) };
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
      const i = y * f.w + x;
      const j = (y >> 1) * w + (x >> 1);
      next.weight[j] += f.weight[i];
      for (let c = 0; c < 3; c++) next.sum[j * 3 + c] += f.sum[i * 3 + c];
    }
    levels.push(next);
  }
  const out = rgb.slice();
  for (let i = 0; i < W * H; i++) {
    if (!hole.bits[i]) continue;
    let [x, y] = [i % W, Math.floor(i / W)];
    for (const l of levels) {
      const j = y * l.w + x;
      if (l.weight[j] > 0) {
        for (let c = 0; c < 3; c++) out[i * 3 + c] = l.sum[j * 3 + c] / l.weight[j];
        break;
      }
      [x, y] = [x >> 1, y >> 1];
    }
  }
  return out;
}

export type Card = { key: string; phrase: string; mask: Mask };
export type Backdrop = { png: Buffer; report: Record<string, { stillThere: boolean; iou: number }> };

export async function backdropFor(memo: Memo, place: Place, cards: Card[], painting: Buffer): Promise<Backdrop> {
  const { width: W, height: H } = FRAME;
  const area = dilate(unionAll(W, H, cards.map((c) => c.mask)), BACKDROP_GROW);
  const names = cards.map((c) => `the ${c.phrase}`);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  const prompt = `Remove ${list} from this painting. Paint what is behind ${cards.length > 1 ? 'them' : 'it'} where ${cards.length > 1 ? 'they were' : 'it was'}: continue the floor, the walls and the background, in the same style and light. Leave everything else exactly as it is. No people, no text.`;
  const edited = await museEdit(memo, { label: `backdrop:${place.key}`, prompt, images: [painting] });
  let png = await pasteInside(painting, edited, area);
  const report: Backdrop['report'] = {};
  const leftover: Mask[] = [];
  for (const card of cards) {
    // Is it still there? SAM by the same phrase, inside the area the backdrop replaced.
    const found = await samFind(memo, { label: `backdrop-check:${place.key}/${card.key}`, image: png, prompt: card.phrase });
    const iou = Math.max(0, ...found.map((f) => maskIou(intersect(f.mask, area), card.mask)));
    const left = found.reduce((px, f) => px + maskArea(intersect(f.mask, card.mask)), 0);
    const stillThere = iou > 0.4 || left > 0.4 * maskArea(card.mask);
    report[card.key] = { stillThere, iou: Math.round(iou * 100) / 100 };
    if (stillThere) leftover.push(dilate(card.mask, BACKDROP_GROW));
  }
  if (leftover.length) png = await pasteInside(png, await smearedBackdrop(cards, painting), unionAll(W, H, leftover), 2);
  return { png, report };
}

/** The smeared fill alone, for a place without a key or when Muse is not wanted. */
export async function smearedBackdrop(cards: Card[], painting: Buffer): Promise<Buffer> {
  const { width: W, height: H } = FRAME;
  const area = dilate(unionAll(W, H, cards.map((c) => c.mask)), BACKDROP_GROW);
  const rgb = new Uint8Array(await sharp(painting).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer());
  return sharp(smearFill(rgb, W, H, area), { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}
