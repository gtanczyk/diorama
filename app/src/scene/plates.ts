// plates: for things the hero carries off, the spot where the thing was, painted empty. Muse edits a close crop
// around the thing; only the thing's mask (grown a little, feathered, matched in tone) is taken from it.
// SAM then looks for the thing again on the plate: if it is still there, the plate is flagged.
import sharp from 'sharp';
import { emptyMask, maskArea, maskToPng, type Mask } from '../image/mask.ts';
import { clampRect, components, dilate, growRect, intersect, maskBox, maskIou, rectMask, subtract, union, unionAll } from '../image/raster.ts';
import type { Memo } from '../meta/memo.ts';
import { museEdit } from '../meta/muse.ts';
import { samFind } from '../meta/sam.ts';
import type { Place } from '../world/schema.ts';
import { FRAME } from './layout.ts';

export const PLATE_GROW = 12;
/** Mean difference (0-255) from the painting just around a patch above which the seam shows. */
export const SEAM_SHOWS = 25;

/** Pastes `patch` over `painting` inside `mask`, with a soft edge. */
export async function pasteInside(painting: Buffer, patch: Buffer, mask: Mask, feather = 4): Promise<Buffer> {
  const { width: W, height: H } = FRAME;
  const alpha = await sharp(await maskToPng(mask)).blur(feather).toColourspace('b-w').raw().toBuffer();
  return pasteAlpha(painting, patch, alpha);
}

/**
 * `patch` over `painting` through `alpha` (raw, one byte per pixel, FRAME size); everything at alpha 0 is left as it
 * was. The RGBA patch is built by hand: sharp's joinChannel with a raw alpha let the whole patch through, so every
 * edit used to replace the whole painting.
 */
export async function pasteAlpha(painting: Buffer, patch: Buffer, alpha: Buffer): Promise<Buffer> {
  const { width: W, height: H } = FRAME;
  const rgb = await sharp(patch).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const rgba = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = rgb[i * 3];
    rgba[i * 4 + 1] = rgb[i * 3 + 1];
    rgba[i * 4 + 2] = rgb[i * 3 + 2];
    rgba[i * 4 + 3] = alpha[i];
  }
  const cut = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  return sharp(painting).resize(W, H, { fit: 'fill' }).composite([{ input: cut }]).png().toBuffer();
}

/**
 * Muse's edit inside `area` only, transparent elsewhere, with a soft edge. A Muse edit repaints the whole picture and
 * often shifts its tone (darker, wetter, another light), so the patch is first matched, channel by channel, to the
 * painting in a ring just outside the area: mean and spread of the edit's ring are mapped onto the painting's.
 */
export async function patchInside(painting: Buffer, edited: Buffer, area: Mask, feather = 4): Promise<{ png: Buffer; ringError: number; stain: number }> {
  const { width: W, height: H } = FRAME;
  const [paint, edit] = await Promise.all([painting, edited].map((b) => sharp(b).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer()));
  const ring = subtract(dilate(area, 18), area);
  const stats = (px: Buffer) => [0, 1, 2].map((c) => {
    let n = 0, sum = 0, sq = 0;
    for (let i = 0; i < W * H; i++) if (ring.bits[i]) (n++, sum += px[i * 3 + c], sq += px[i * 3 + c] ** 2);
    const mean = n ? sum / n : 0;
    return { mean, sd: n ? Math.sqrt(Math.max(1, sq / n - mean * mean)) : 1 };
  });
  const [want, have] = [stats(paint), stats(edit)];
  // How far the matched edit still is from the painting just around the patch: a Muse edit that moved things
  // (it repaints the whole picture) leaves a seam however good its fill looks, and scores high here.
  let err = 0, n = 0;
  for (let i = 0; i < W * H; i++) {
    if (!ring.bits[i]) continue;
    for (let c = 0; c < 3; c++) {
      const k = Math.min(1.6, Math.max(0.6, want[c].sd / have[c].sd));
      err += Math.abs(want[c].mean + (edit[i * 3 + c] - have[c].mean) * k - paint[i * 3 + c]);
    }
    n += 3;
  }
  const alpha = await sharp(await maskToPng(area)).blur(feather).extractChannel(0).raw().toBuffer();
  const out = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    if (!alpha[i]) continue;
    for (let c = 0; c < 3; c++) {
      // The spread is matched only part way, so a flat ring cannot flatten the fill to one colour.
      const k = Math.min(1.6, Math.max(0.6, want[c].sd / have[c].sd));
      out[i * 4 + c] = Math.max(0, Math.min(255, Math.round(want[c].mean + (edit[i * 3 + c] - have[c].mean) * k)));
    }
    out[i * 4 + 3] = alpha[i];
  }
  // A stain: the share of the patch darker or lighter than nearly all of the ground around it (a hole, a puddle,
  // a smear Muse painted where the thing was).
  const luma = (px: Buffer, i: number, step: number) => 0.3 * px[i * step] + 0.59 * px[i * step + 1] + 0.11 * px[i * step + 2];
  const around: number[] = [];
  for (let i = 0; i < W * H; i++) if (ring.bits[i]) around.push(luma(paint, i, 3));
  around.sort((a, b) => a - b);
  const [lo, hi] = around.length ? [around[Math.floor(around.length * 0.02)] - 20, around[Math.floor(around.length * 0.98)] + 20] : [0, 255];
  let inside = 0, off = 0;
  for (let i = 0; i < W * H; i++) {
    if (!area.bits[i]) continue;
    inside++;
    const l = luma(out, i, 4);
    if (l < lo || l > hi) off++;
  }
  return { png: await sharp(out, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer(), ringError: n ? err / n : 0, stain: inside ? off / inside : 0 };
}

/**
 * A Muse edit of the part of the painting around a small thing, blown up to the full frame, then put back at its place
 * in a copy of the painting; null for a thing too large for a close view. Seen whole, a small thing is a few pixels
 * Muse may fill with whatever it likes; seen close it may redraw the ground with other lines. Neither wins always.
 */
async function editAround(memo: Memo, label: string, prompt: string, painting: Buffer, mask: Mask, take = 0): Promise<Buffer | null> {
  const { width: W, height: H } = FRAME;
  const box = maskBox(mask);
  if (!box) return null;
  // Three times the thing each way, in the frame's shape, at least a quarter of the frame wide.
  const w = Math.min(W, Math.max(W / 4, (box[2] - box[0]) * 3, ((box[3] - box[1]) * 3 * W) / H));
  if (w > W * 0.6) return null;
  const h = (w * H) / W;
  const left = Math.round(Math.max(0, Math.min(W - w, (box[0] + box[2]) / 2 - w / 2)));
  const top = Math.round(Math.max(0, Math.min(H - h, (box[1] + box[3]) / 2 - h / 2)));
  const crop = { left, top, width: Math.min(W - left, Math.round(w)), height: Math.min(H - top, Math.round(h)) };
  const full = await sharp(painting).resize(W, H, { fit: 'fill' }).png().toBuffer();
  const close = await sharp(full).extract(crop).resize(W, H, { kernel: 'lanczos3' }).png().toBuffer();
  const edited = await museEdit(memo, { label: `${label}:close`, prompt, images: [close], take });
  const back = await sharp(edited).resize(crop.width, crop.height, { fit: 'fill' }).png().toBuffer();
  return sharp(full).composite([{ input: back, left: crop.left, top: crop.top }]).png().toBuffer();
}

/** How far from the thing's mask a part SAM left out (a rope, a handle, a strap) may reach. */
export const ATTACHED_REACH = 72;

/**
 * SAM's mask often leaves out a part of the thing (the rope tied to a bucket), which then lies on the floor once the
 * thing is gone. Muse, asked to remove the thing, removes those parts too: where the edit differs strongly from the
 * painting just outside the area, in blobs touching it, the area grows to take them in. A shifted or retoned edit
 * changes everything a little, and Muse adds things of its own; only clear changes towards the ground count, and at most as much again as the thing itself.
 */
export async function withAttached(painting: Buffer, edited: Buffer, mask: Mask, area: Mask): Promise<Mask> {
  const { width: W, height: H } = FRAME;
  const [paint, edit] = await Promise.all([painting, edited].map((b) => sharp(b).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer()));
  const near = subtract(dilate(mask, ATTACHED_REACH), area);
  // The edit's overall shift in tone, read on the ring around the area, is taken out first.
  const ring = subtract(dilate(area, 10), area);
  const shift = [0, 1, 2].map((c) => {
    const d: number[] = [];
    for (let i = 0; i < W * H; i++) if (ring.bits[i]) d.push(edit[i * 3 + c] - paint[i * 3 + c]);
    return d.length ? d.sort((a, b) => a - b)[d.length >> 1] : 0;
  });
  // The ground, as the painting has it around the area.
  const ground = [0, 1, 2].map((c) => {
    const v: number[] = [];
    for (let i = 0; i < W * H; i++) if (ring.bits[i]) v.push(paint[i * 3 + c]);
    return v.length ? v.sort((a, b) => a - b)[v.length >> 1] : 0;
  });
  const fromGround = (px: Buffer, i: number, off = [0, 0, 0]) => Math.hypot(...[0, 1, 2].map((c) => px[i * 3 + c] - off[c] - ground[c]));
  const changed = emptyMask(W, H);
  for (let i = 0; i < W * H; i++) {
    if (!near.bits[i]) continue;
    const d = Math.hypot(...[0, 1, 2].map((c) => edit[i * 3 + c] - shift[c] - paint[i * 3 + c]));
    // Removed means the edit turned it into ground: something Muse added (a stain, a shadow) is not part of the thing.
    if (d > 60 && fromGround(edit, i, shift) < fromGround(paint, i) - 40) changed.bits[i] = 1;
  }
  const touching = dilate(area, 2);
  let budget = maskArea(mask);
  const parts: Mask[] = [];
  for (const blob of components(dilate(changed, 1))) {
    const size = maskArea(blob);
    if (size < 40 || size > budget || maskArea(intersect(blob, touching)) === 0) continue;
    parts.push(blob);
    budget -= size;
  }
  return parts.length ? union(area, dilate(unionAll(W, H, parts), 4)) : area;
}

/** How bad a patch looks, in seam units: its seam, and a stain over a tenth of it as bad as a seam that shows. */
const STAIN_WEIGHT = SEAM_SHOWS * 10;
const flaw = (p: { ringError: number; stain: number }) => p.ringError + STAIN_WEIGHT * p.stain;

/** ringError: mean difference (0-255) from the painting just around the patch (see SEAM_SHOWS). */
export type Plate = { thing: string; png: Buffer; stillThere: boolean; iou: number; ringError: number; stain: number };

export async function plateFor(memo: Memo, place: Place, thing: { key: string; phrase: string; mask: Mask }, painting: Buffer, ground: string): Promise<Plate> {
  const prompt = `Remove the ${thing.phrase} from this picture. Where it was, paint only ${ground}, continuing the surroundings exactly: the same flat colours, texture, ink lines and light as right next to it. Add nothing new: no objects, stones, debris, stains, puddles or shadows. Leave everything else exactly as it is. No people, no text.`;
  const label = `plate:${place.key}/${thing.key}`;
  const area = dilate(thing.mask, PLATE_GROW);
  // Two edits, the whole painting and a close view; the one that meets the painting around the patch best is kept.
  const takes = async (take: number) => {
    const edits = (await Promise.all([museEdit(memo, { label, prompt, images: [painting], take }), editAround(memo, label, prompt, painting, thing.mask, take)]))
      .filter((e): e is Buffer => e !== null);
    // The plate is only the patch where the thing was: drawn over the painting (or the backdrop), nothing else can differ.
    return Promise.all(edits.map(async (e) => patchInside(painting, e, await withAttached(painting, e, thing.mask, area))));
  };
  let patches = await takes(0);
  // A seam or a stain that shows: one more take of each, and the best of all four.
  if (Math.min(...patches.map(flaw)) > SEAM_SHOWS) patches = [...patches, ...(await takes(1))];
  const { png, ringError, stain } = patches.sort((a, b) => flaw(a) - flaw(b))[0];
  // Is it still there? SAM by the same phrase on the painting with the patch on, inside the area the plate replaced.
  const patched = await sharp(painting).resize(FRAME.width, FRAME.height, { fit: 'fill' }).composite([{ input: png }]).png().toBuffer();
  const found = await samFind(memo, { label: `plate-check:${place.key}/${thing.key}`, image: patched, prompt: thing.phrase });
  const iou = Math.max(0, ...found.map((f) => maskIou(intersect(f.mask, area), thing.mask)));
  const left = found.reduce((px, f) => px + maskArea(intersect(f.mask, thing.mask)), 0);
  return { thing: thing.key, png, iou, ringError, stain, stillThere: iou > 0.4 || left > 0.4 * maskArea(thing.mask) };
}

/** How far around a takeable thing a change keeps off: Muse shifts what it redraws by a few dozen px. */
export const CHANGE_KEEP_OFF = 24;

/**
 * Where a change plate shows: the thing grown wide (light spills), soft-edged, but never over the `others`
 * (things the hero can take, grown by CHANGE_KEEP_OFF) outside the changed thing itself. They keep the
 * painting's pixels, so their hover outline and their plate still match what is seen.
 */
export async function changeAlpha(mask: Mask, others: Mask[]): Promise<Buffer> {
  const alpha = await sharp(await maskToPng(dilate(mask, 48))).blur(14).extractChannel(0).raw().toBuffer();
  if (!others.length) return alpha;
  let keep: Mask | undefined;
  for (const o of others) keep = keep ? union(keep, o) : o;
  const off = await sharp(await maskToPng(dilate(keep!, CHANGE_KEEP_OFF))).blur(6).extractChannel(0).raw().toBuffer();
  for (let i = 0; i < alpha.length; i++) if (!mask.bits[i]) alpha[i] = Math.round((alpha[i] * (255 - off[i])) / 255);
  return alpha;
}

/**
 * The changed thing's own shape in its change plate: Muse redraws all it sees, and a boat that gets a lantern may come
 * back longer or lower than the one painted, with the lantern standing up out of it. SAM by how it looks now
 * (`looks`: what was found near the painted thing, all of it), else by its box grown for that, on the plate; undefined
 * when what it finds is not the thing (little of the painted one, or far bigger). The runtime outlines this while
 * the change holds, so the hover line follows the thing as it is drawn then.
 */
export async function changeShape(memo: Memo, place: Place, thing: { key: string; mask: Mask }, plate: Buffer, looks: string): Promise<Mask | undefined> {
  const { width: W, height: H } = FRAME;
  const box = maskBox(thing.mask);
  if (!box) return undefined;
  const near = clampRect(growRect(box, 1.6), W, H);
  const rgba = await sharp(plate).ensureAlpha().raw().toBuffer();
  const flat = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).removeAlpha().png().toBuffer();
  const px = maskArea(thing.mask);
  // Only where the plate shows: elsewhere the painting is drawn, not the change.
  const shown = (m: Mask): Mask => ({ ...m, bits: m.bits.map((b, i) => (b && rgba[i * 4 + 3] > 96 ? 1 : 0)) });
  const fits = (m: Mask) => maskArea(intersect(m, thing.mask)) >= 0.6 * px && maskArea(m) <= 3 * px;
  const nearBox = rectMask(W, H, near);
  const named = await samFind(memo, { label: `change-shape:${place.key}/${thing.key}:${looks}`, image: flat, prompt: looks });
  const parts = named.filter((f) => maskArea(intersect(f.mask, nearBox)) >= 0.5 * maskArea(f.mask)).map((f) => f.mask);
  if (parts.length) {
    const shape = shown(unionAll(W, H, parts));
    if (fits(shape)) return shape;
  }
  const [left, top, right, bottom] = near;
  const [boxed] = await samFind(memo, { label: `change-shape-box:${place.key}/${thing.key}`, image: flat, prompt: [{ left, top, right, bottom }] });
  const shape = boxed && shown(boxed.mask);
  return shape && fits(shape) ? shape : undefined;
}

/** For a thing the story changes (a beacon lit): the thing as it looks after, transparent elsewhere, so several
 * changes in one place stack. Light may spill, so the area is wide. */
export async function changePlate(memo: Memo, place: Place, thing: { key: string; phrase: string; mask: Mask }, painting: Buffer, looks: string, others: Mask[] = []): Promise<Buffer> {
  const prompt = `Change only the ${thing.phrase} in this painting: it is now ${looks}. Add the light it casts on what is right around it. Leave everything else exactly as it is and where it is, same style. No people, no animals, no text.`;
  const edited = await museEdit(memo, { label: `change:${place.key}/${thing.key}:${looks}`, prompt, images: [painting] });
  const { width: W, height: H } = FRAME;
  const alpha = await changeAlpha(thing.mask, others);
  const rgba = await sharp(edited).resize(W, H, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
  for (let i = 0; i < W * H; i++) rgba[i * 4 + 3] = alpha[i];
  return sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}
