// backdrop: the painting with every card (each sharp standing thing) taken out, for parallax. When the
// cards slide against the floor, a few px of what is behind them show; Muse paints what is there.
// Muse repaints the whole picture on an edit, so only the cards' masks (grown, feathered) are taken from it.
// A card SAM still finds on the backdrop gets a smeared fill of its surroundings instead: blurry beats a ghost.
// Muse sometimes leaves a card's dark silhouette behind (a ghost SAM does not call by the card's name): that
// is read from the pixels, the outline darker inside than out, and asked of Muse once more, then smeared.
// Muse's repaint is brought to the painting's tone around each card before it is pasted, so it leaves no patch.
import sharp from 'sharp';
import { maskArea, type Mask } from '../image/mask.ts';
import { dilate, intersect, maskIou, subtract, unionAll } from '../image/raster.ts';
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
export type Backdrop = { png: Buffer; report: Record<string, { stillThere: boolean; iou: number; ghost?: boolean }> };

/** Darker than this (in luma, 0..255) across its outline, a removed card left its silhouette. */
const GHOST_STEP = 12;
/** ...and this share of its inside is darker than what Muse painted around it. */
const GHOST_SHARE = 0.45;

const luma = (rgb: Uint8Array, i: number) => 0.3 * rgb[i * 3] + 0.59 * rgb[i * 3 + 1] + 0.11 * rgb[i * 3 + 2];

/**
 * Did the removal leave a dark patch the card's shape (its silhouette, or Muse's repaint a shade darker than the
 * painting around it)? A background that continues does not follow the outline of what was pasted: a ghost
 * does, darker just inside the pasted area than just outside, all the way round, and most of it darker than
 * the painting around it. `area`: what was pasted for one card (its mask, grown).
 */
export function ghostOf(rgb: Uint8Array, W: number, H: number, area: Mask): { step: number; share: number; ghost: boolean } {
  const inner = subtract(dilate(area, -2), dilate(area, -8));
  const outer = subtract(dilate(area, 12), dilate(area, 5));
  const core = dilate(area, -4);
  const mean = (m: Mask) => {
    let [sum, n] = [0, 0];
    for (let i = 0; i < W * H; i++) if (m.bits[i]) [sum, n] = [sum + luma(rgb, i), n + 1];
    return n ? sum / n : NaN;
  };
  const around: number[] = [];
  for (let i = 0; i < W * H; i++) if (outer.bits[i]) around.push(luma(rgb, i));
  around.sort((a, b) => a - b);
  const median = around[around.length >> 1] ?? 0;
  let [dark, n] = [0, 0];
  for (let i = 0; i < W * H; i++) {
    if (!core.bits[i]) continue;
    n++;
    if (luma(rgb, i) < median - 20) dark++;
  }
  const step = mean(outer) - mean(inner);
  const share = n ? dark / n : 0;
  return { step: Math.round(step), share: Math.round(share * 100) / 100, ghost: n > 200 && step > GHOST_STEP && share > GHOST_SHARE };
}

/**
 * Muse repaints the whole picture on an edit, often a shade darker or bluer, and not evenly: pasted back
 * inside a card's area that shift shows as a patch the card's shape. Where both show the same thing (a ring
 * just outside the area) the difference is read, carried smoothly into the area, and added to Muse's pixels,
 * so the repaint meets the painting with no seam.
 */
export async function matchTone(edited: Buffer, painting: Buffer, area: Mask): Promise<Buffer> {
  const { width: W, height: H } = FRAME;
  const [e, p] = await Promise.all([edited, painting].map(async (b) => new Uint8Array(await sharp(b).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer())));
  const ring = subtract(dilate(area, 10), area);
  // The difference, halved and centred on 128 so it fits a byte; the smear fills it in from the ring.
  const diff = new Uint8Array(W * H * 3).fill(128);
  for (let i = 0; i < W * H; i++) if (ring.bits[i]) for (let c = 0; c < 3; c++) diff[i * 3 + c] = 128 + ((p[i * 3 + c] - e[i * 3 + c]) >> 1);
  // Blurred, as the smear comes in blocks deep inside a big area.
  const field = new Uint8Array(await sharp(smearFill(diff, W, H, area, ring), { raw: { width: W, height: H, channels: 3 } }).blur(8).raw().toBuffer());
  const out = Uint8Array.from(e);
  const reach = dilate(area, 10);
  for (let i = 0; i < W * H; i++) {
    if (!reach.bits[i]) continue;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.max(0, Math.min(255, e[i * 3 + c] + 2 * (field[i * 3 + c] - 128)));
  }
  return sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

async function ghostsIn(png: Buffer, cards: Card[]): Promise<Card[]> {
  const { width: W, height: H } = FRAME;
  const rgb = new Uint8Array(await sharp(png).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer());
  return cards.filter((card) => ghostOf(rgb, W, H, dilate(card.mask, BACKDROP_GROW)).ghost);
}

export async function backdropFor(memo: Memo, place: Place, cards: Card[], painting: Buffer): Promise<Backdrop> {
  const { width: W, height: H } = FRAME;
  const area = dilate(unionAll(W, H, cards.map((c) => c.mask)), BACKDROP_GROW);
  const names = cards.map((c) => `the ${c.phrase}`);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  const prompt = `Remove ${list} from this painting. Paint what is behind ${cards.length > 1 ? 'them' : 'it'} where ${cards.length > 1 ? 'they were' : 'it was'}: continue the floor, the walls and the background, in the same style and light. Leave everything else exactly as it is. No people, no text.`;
  const edited = await museEdit(memo, { label: `backdrop:${place.key}`, prompt, images: [painting] });
  let png = await pasteInside(painting, await matchTone(edited, painting, area), area);
  const report: Backdrop['report'] = {};
  const leftover: Mask[] = [];
  // Is each still there? SAM by the same phrase, inside the area the backdrop replaced; all cards at once.
  const seen = await Promise.all(cards.map((card) => samFind(memo, { label: `backdrop-check:${place.key}/${card.key}`, image: png, prompt: card.phrase })));
  cards.forEach((card, i) => {
    const found = seen[i];
    const iou = Math.max(0, ...found.map((f) => maskIou(intersect(f.mask, area), card.mask)));
    const left = found.reduce((px, f) => px + maskArea(intersect(f.mask, card.mask)), 0);
    const stillThere = iou > 0.4 || left > 0.4 * maskArea(card.mask);
    report[card.key] = { stillThere, iou: Math.round(iou * 100) / 100 };
    if (stillThere) leftover.push(dilate(card.mask, BACKDROP_GROW));
  });
  // A ghost left where a card was taken out: Muse once more on those, then the smear for any still there.
  let ghosts = await ghostsIn(png, cards.filter((c) => !report[c.key].stillThere));
  if (ghosts.length) {
    const named = ghosts.map((c) => `the ${c.phrase}`).join(', ');
    const again = await museEdit(memo, {
      label: `backdrop-ghost:${place.key}`,
      prompt: `A dark silhouette is left in this painting where ${named} stood. Paint over it what is behind: continue the background, the water, the floor and the light around it, with no shape, shadow or outline of ${ghosts.length > 1 ? 'them' : 'it'}. Leave everything else exactly as it is. No people, no text.`,
      images: [png],
    }).catch(() => undefined);
    const redo = dilate(unionAll(W, H, ghosts.map((c) => c.mask)), BACKDROP_GROW);
    if (again) png = await pasteInside(png, await matchTone(again, png, redo), redo);
    const still = new Set((await ghostsIn(png, ghosts)).map((c) => c.key));
    for (const c of ghosts) report[c.key].ghost = true;
    ghosts = ghosts.filter((c) => still.has(c.key));
    for (const c of ghosts) leftover.push(dilate(c.mask, BACKDROP_GROW));
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
