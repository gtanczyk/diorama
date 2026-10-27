// plates: for things the hero carries off, the spot where the thing was, painted empty. Muse edits a close crop
// around the thing; only the thing's mask (grown a little, feathered, matched in tone) is taken from it.
// SAM then looks for the thing again on the plate: if it is still there, the plate is flagged.
import sharp from 'sharp';
import { maskArea, maskToPng, type Mask } from '../image/mask.ts';
import { dilate, intersect, maskBox, maskIou, subtract } from '../image/raster.ts';
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
  const cut = await sharp(patch).resize(W, H, { fit: 'fill' }).removeAlpha().joinChannel(alpha, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();
  return sharp(painting).resize(W, H, { fit: 'fill' }).composite([{ input: cut }]).png().toBuffer();
}

/**
 * Muse's edit inside `area` only, transparent elsewhere, with a soft edge. A Muse edit repaints the whole picture and
 * often shifts its tone (darker, wetter, another light), so the patch is first matched, channel by channel, to the
 * painting in a ring just outside the area: mean and spread of the edit's ring are mapped onto the painting's.
 */
export async function patchInside(painting: Buffer, edited: Buffer, area: Mask, feather = 4): Promise<{ png: Buffer; ringError: number }> {
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
  return { png: await sharp(out, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer(), ringError: n ? err / n : 0 };
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

/** ringError: mean difference (0-255) from the painting just around the patch (see SEAM_SHOWS). */
export type Plate = { thing: string; png: Buffer; stillThere: boolean; iou: number; ringError: number };

export async function plateFor(memo: Memo, place: Place, thing: { key: string; phrase: string; mask: Mask }, painting: Buffer, ground: string): Promise<Plate> {
  const prompt = `Remove the ${thing.phrase} from this picture. Where it was, paint only ${ground}, continuing the surroundings exactly: the same flat colours, texture, ink lines and light as right next to it. Add nothing new: no objects, stones, debris, stains, puddles or shadows. Leave everything else exactly as it is. No people, no text.`;
  const label = `plate:${place.key}/${thing.key}`;
  const area = dilate(thing.mask, PLATE_GROW);
  // Two edits, the whole painting and a close view; the one that meets the painting around the patch best is kept.
  const takes = async (take: number) => {
    const edits = (await Promise.all([museEdit(memo, { label, prompt, images: [painting], take }), editAround(memo, label, prompt, painting, thing.mask, take)]))
      .filter((e): e is Buffer => e !== null);
    // The plate is only the patch where the thing was: drawn over the painting (or the backdrop), nothing else can differ.
    return Promise.all(edits.map((e) => patchInside(painting, e, area)));
  };
  let patches = await takes(0);
  // A seam that shows: one more take of each, and the best of all four.
  if (Math.min(...patches.map((p) => p.ringError)) > SEAM_SHOWS) patches = [...patches, ...(await takes(1))];
  const { png, ringError } = patches.sort((a, b) => a.ringError - b.ringError)[0];
  // Is it still there? SAM by the same phrase on the painting with the patch on, inside the area the plate replaced.
  const patched = await sharp(painting).resize(FRAME.width, FRAME.height, { fit: 'fill' }).composite([{ input: png }]).png().toBuffer();
  const found = await samFind(memo, { label: `plate-check:${place.key}/${thing.key}`, image: patched, prompt: thing.phrase });
  const iou = Math.max(0, ...found.map((f) => maskIou(intersect(f.mask, area), thing.mask)));
  const left = found.reduce((px, f) => px + maskArea(intersect(f.mask, thing.mask)), 0);
  return { thing: thing.key, png, iou, ringError, stillThere: iou > 0.4 || left > 0.4 * maskArea(thing.mask) };
}

/** For a thing the story changes (a beacon lit): the thing as it looks after, transparent elsewhere, so several
 * changes in one place stack. Light may spill, so the area is wide. */
export async function changePlate(memo: Memo, place: Place, thing: { key: string; phrase: string; mask: Mask }, painting: Buffer, looks: string): Promise<Buffer> {
  const prompt = `Change only the ${thing.phrase} in this painting: it is now ${looks}. Add the light it casts on what is right around it. Leave everything else exactly as it is, same style. No people, no text.`;
  const edited = await museEdit(memo, { label: `change:${place.key}/${thing.key}:${looks}`, prompt, images: [painting] });
  const { width: W, height: H } = FRAME;
  const alpha = await sharp(await maskToPng(dilate(thing.mask, 48))).blur(14).extractChannel(0).raw().toBuffer();
  const rgba = await sharp(edited).resize(W, H, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
  for (let i = 0; i < W * H; i++) rgba[i * 4 + 3] = alpha[i];
  return sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}
