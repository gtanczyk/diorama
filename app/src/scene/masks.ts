// masks: one SAM 3.1 mask per painted thing and per floor, checked against where Spark saw it.
// Things: SAM by phrase, the instances near Spark's box; a mask that fails the sanity gate is
// asked again with the box; if that fails too the box itself is the mask, marked coarse.
// Floors: SAM by name and by the box of Spark's cells; the candidate that agrees best with the
// cells wins; with none close enough the cells are the floor, marked coarse.
import sharp from 'sharp';
import { emptyMask, maskArea, type Mask } from '../image/mask.ts';
import { clampRect, components, dilate, intersect, subtract, maskBox, maskIou, polygonMask, rectArea, rectIou, rectMask, unionAll, withoutSpecks, type Rect } from '../image/raster.ts';
import type { Memo } from '../meta/memo.ts';
import { SAM_MAX_BOXES, samFind, type Box, type Found } from '../meta/sam.ts';
import type { Place } from '../world/schema.ts';
import { FRAME, type Layout } from './layout.ts';
import { cellsBox, cellsMask, GRID, type Kind, type Spots } from './locate.ts';

export type MaskSource = 'sam-text' | 'sam-box' | 'colour-cut' | 'spark-box' | 'layout-box' | 'spark-cells' | 'layout';

/** whole: px added by the whole-thing pass (parts SAM by name left out: what sits in or on it). */
export type ThingMask = { key: string; kind: Kind; phrase: string; source: MaskSource; coarse: boolean; px: number; box: Rect; mask: Mask; whole?: number };
export type FloorMask = { key: string; source: MaskSource; coarse: boolean; px: number; iouCells: number; iouLayout: number; mask: Mask };

const { width: W, height: H } = FRAME;
const toBox = ([left, top, right, bottom]: Rect): Box => ({ left, top, right, bottom });
const fromBox = (b: Box): Rect => [b.left, b.top, b.right, b.bottom];

/** Where the layout put a thing, for things Spark could not find. */
export function layoutBox(layout: Layout, key: string): Rect | undefined {
  const t = layout.things.find((b) => b.key === key);
  return t && clampRect([t.x - t.width / 2, t.footY - t.height, t.x + t.width / 2, t.footY], W, H);
}

/**
 * The mask-sanity gate for a thing against the box it should fill. Empty is not found; much bigger
 * than the box while barely overlapping it is a different object (SAM takes every instance it sees).
 */
export function thingMaskFault(mask: Mask, prior: Rect): string | undefined {
  const px = maskArea(mask);
  if (px < 150) return px === 0 ? 'empty' : `only ${px} px`;
  const box = maskBox(mask)!;
  const iou = rectIou(box, prior);
  if (px > 3 * rectArea(prior) && iou < 0.3) return `${px} px is over 3x its box and overlaps it ${iou.toFixed(2)}`;
  if (iou < 0.1) return `lies outside its box (overlap ${iou.toFixed(2)})`;
}

/**
 * A box prompt sometimes returns what surrounds the thing (the puddle around a can) instead of it.
 * Such a mask leaves the middle of the box empty.
 */
export function hollowFault(mask: Mask, [x0, y0, x1, y1]: Rect): string | undefined {
  const [w, h] = [x1 - x0, y1 - y0];
  const middle = rectMask(mask.width, mask.height, [x0 + w / 3, y0 + h / 3, x1 - w / 3, y1 - h / 3]);
  const area = maskArea(middle);
  const covered = area > 0 ? maskArea(intersect(mask, middle)) / area : 1;
  if (covered < 0.25) return `covers only ${Math.round(covered * 100)}% of the middle of its box`;
}

/**
 * The last try before a plain box: inside the box, the pixels whose colour stands out from a ring
 * just outside it (the floor or wall around the thing), as one solid blob.
 */
export function colourCut(rgb: Buffer, box: Rect, ring = 12): Mask | undefined {
  const [x0, y0, x1, y1] = clampRect(box, W, H);
  const [ox0, oy0, ox1, oy1] = clampRect([x0 - ring, y0 - ring, x1 + ring, y1 + ring], W, H);
  const sum = [0, 0, 0];
  const sq = [0, 0, 0];
  let n = 0;
  for (let y = oy0; y < oy1; y++) {
    for (let x = ox0; x < ox1; x++) {
      if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;
      for (let c = 0; c < 3; c++) {
        const v = rgb[(y * W + x) * 3 + c];
        sum[c] += v;
        sq[c] += v * v;
      }
      n++;
    }
  }
  if (n === 0) return undefined;
  const mean = sum.map((v) => v / n);
  const spread = Math.sqrt(sq.reduce((t, v, c) => t + v / n - mean[c] ** 2, 0));
  const limit = Math.max(40, 2 * spread);
  const raw = emptyMask(W, H);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * W + x;
      const d = Math.hypot(rgb[i * 3] - mean[0], rgb[i * 3 + 1] - mean[1], rgb[i * 3 + 2] - mean[2]);
      if (d > limit) raw.bits[i] = 1;
    }
  }
  const blob = components(dilate(dilate(raw, 2), -2))[0];
  if (!blob) return undefined;
  // Fill holes: whatever inside the box the outside can't reach is part of the thing.
  const outside = emptyMask(W, H);
  const stack: number[] = [];
  for (let x = x0; x < x1; x++) stack.push(y0 * W + x, (y1 - 1) * W + x);
  for (let y = y0; y < y1; y++) stack.push(y * W + x0, y * W + x1 - 1);
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % W;
    const y = Math.floor(i / W);
    if (x < x0 || x >= x1 || y < y0 || y >= y1 || outside.bits[i] || blob.bits[i]) continue;
    outside.bits[i] = 1;
    stack.push(i - 1, i + 1, i - W, i + W);
  }
  const solid = rectMask(W, H, [x0, y0, x1, y1]);
  const filled = subtract(solid, outside);
  const share = maskArea(filled) / Math.max(1, rectArea([x0, y0, x1, y1]));
  return share > 0.15 && share < 0.92 ? filled : undefined;
}

/** A single SAM match near a misplaced box: similar size, centre within twice the box's size. */
export function loneMatch(found: Rect, box: Rect): boolean {
  const ratio = rectArea(found) / Math.max(1, rectArea(box));
  const size = Math.max(box[2] - box[0], box[3] - box[1]);
  const dist = Math.hypot((found[0] + found[2] - box[0] - box[2]) / 2, (found[1] + found[3] - box[1] - box[3]) / 2);
  return ratio > 0.25 && ratio < 4 && dist < 2 * size;
}

/** The instances that belong to the thing: the one nearest its box, plus any others mostly inside it. */
export function pickInstances(found: Found[], prior: Rect, passage = false): Mask | undefined {
  if (found.length === 0) return undefined;
  const scored = found.map((f) => {
    const box = fromBox(f.box);
    const inside = rectArea([Math.max(box[0], prior[0]), Math.max(box[1], prior[1]), Math.min(box[2], prior[2]), Math.min(box[3], prior[3])]);
    return { f, iou: rectIou(box, prior), inside: rectArea(box) > 0 ? inside / rectArea(box) : 0 };
  });
  const best = scored.reduce((a, b) => (b.iou > a.iou ? b : a));
  if (best.iou === 0) return undefined;
  const keep = scored.filter((s) => s === best || s.inside > 0.6);
  const mask = unionAll(W, H, keep.map((s) => s.f.mask));
  // Stray specks of a lossy mask would each become an occluder later.
  return withoutSpecks(mask, passage ? 8 : Math.max(60, maskArea(mask) * 0.03));
}

/**
 * The box SAM is asked by for the whole thing: its mask's box joined with Spark's (Spark boxes a "bucket of fish
 * heads" with the fish), grown on the top and the sides, where contents stick out; barely below, that is floor.
 */
export function wholeBox(mask: Rect, spark: Rect | undefined): Rect {
  const [x0, y0, x1, y1] = spark ? [Math.min(mask[0], spark[0]), Math.min(mask[1], spark[1]), Math.max(mask[2], spark[2]), Math.max(mask[3], spark[3])] : mask;
  const g = 0.15 * Math.max(x1 - x0, y1 - y0);
  return clampRect([x0 - g, y0 - 2 * g, x1 + g, y1 + 0.2 * g], W, H);
}

/**
 * The thing as one piece: SAM by name (`named`) joined with the parts SAM by the whole box (`boxed`) finds attached
 * to it. Refused when the box found something else (it covers little of the named mask) or took in its surroundings
 * (it adds over twice the thing itself); `others` (the other things) are never taken. Specks and slivers along the
 * outline are not parts. Returns the mask and the px it gained (0: as it was).
 */
export function wholeThing(named: Mask, boxed: Mask | undefined, others: Mask): { mask: Mask; added: number; why?: string } {
  const px = maskArea(named);
  if (!boxed || px === 0) return { mask: named, added: 0 };
  const cover = maskArea(intersect(boxed, named)) / px;
  if (cover < 0.6) return { mask: named, added: 0, why: `the box found something else (covers ${Math.round(cover * 100)}% of it)` };
  const extra = subtract(subtract(boxed, dilate(named, 2)), others);
  const touch = dilate(named, 4);
  const parts = components(extra).filter((c) => maskArea(c) >= Math.max(80, 0.01 * px) && maskArea(intersect(c, touch)) > 0);
  const added = parts.reduce((n, c) => n + maskArea(c), 0);
  if (added < 0.03 * px) return { mask: named, added: 0 };
  // Contents can be as big as their container (a heap of fish over a small bucket), not much bigger.
  if (added > 2 * px) return { mask: named, added: 0, why: `the box took in ${added} px around it, over twice the thing` };
  // The 2 px seam left between the mask and its parts closes with them.
  const joined = unionAll(named.width, named.height, [named, ...parts]);
  const closed = subtract(dilate(dilate(joined, 3), -3), others);
  return { mask: closed, added: maskArea(closed) - px };
}

async function samBoxes(memo: Memo, label: string, painting: Buffer, boxes: Rect[]): Promise<(Mask | undefined)[]> {
  const out: (Mask | undefined)[] = [];
  for (let i = 0; i < boxes.length; i += SAM_MAX_BOXES) {
    const chunk = boxes.slice(i, i + SAM_MAX_BOXES);
    const found = await samFind(memo, { label: `${label}#${i / SAM_MAX_BOXES}`, image: painting, prompt: chunk.map(toBox) });
    // One object per box; the parser keeps the prompt's order as the object id.
    chunk.forEach((_, j) => out.push(found.find((f) => f.id === String(j))?.mask));
  }
  return out;
}

export async function maskThings(memo: Memo, place: Place, layout: Layout, spots: Spots, painting: Buffer, log: (line: string) => void): Promise<ThingMask[]> {
  const painted = place.things.filter((t) => t.role !== 'npc');
  const tried = await Promise.all(painted.map(async (t) => {
    const spot = spots[t.key];
    const sparkBox = spot.box && clampRect(spot.box, W, H);
    let prior = sparkBox && rectArea(sparkBox) > 0 ? sparkBox : layoutBox(layout, t.key)!;
    // The phrase, Spark's other name for it, then the head noun: SAM often knows "can" when it misses "brass oil can".
    const passage = t.role === 'exit' && (spot.kind === 'walk-on' || spot.kind === 'flat');
    const phrases = [...new Set([...(passage ? [`entire ${spot.phrase}, all visible steps and landings up to the edge of the image`] : []), spot.phrase, spot.also, spot.phrase.trim().split(/\s+/).at(-1)].filter((p): p is string => !!p?.trim()))];
    let mask: Mask | undefined;
    let lone: Found | undefined;
    for (const [i, phrase] of phrases.entries()) {
      const found = await samFind(memo, { label: `mask:${place.key}/${t.key}${i ? `~${phrase}` : ''}`, image: painting, prompt: phrase });
      mask = pickInstances(found, prior, passage);
      if (mask) break;
      if (found.length === 1 && !lone) lone = found[0];
    }
    // Spark's box can sit beside the thing. One SAM match of the right size close by is the thing.
    if (!mask && lone && sparkBox && loneMatch(fromBox(lone.box), sparkBox)) {
      log(`${t.key}: Spark's box misses it; took SAM's only match nearby`);
      mask = withoutSpecks(lone.mask, Math.max(60, maskArea(lone.mask) * 0.03));
      prior = fromBox(lone.box);
    }
    const fault = mask ? thingMaskFault(mask, prior) : `SAM found no "${phrases.join('" or "')}"`;
    return { t, spot, prior, fromSpark: !!sparkBox && prior !== layoutBox(layout, t.key), mask, fault };
  }));

  const retry = tried.filter((r) => r.fault);
  const pixels = await sharp(painting).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const boxed = await samBoxes(memo, `mask-box:${place.key}`, painting, retry.map((r) => clampRect(r.prior, W, H)));
  const masked = tried.map((r) => {
    const base = { key: r.t.key, kind: r.spot.kind, phrase: r.spot.phrase };
    let mask = r.mask;
    let source: MaskSource = 'sam-text';
    if (r.fault) {
      log(`${r.t.key}: ${r.fault}, asking SAM with the box`);
      const byBox = boxed[retry.indexOf(r)];
      const boxFault = byBox ? thingMaskFault(byBox, r.prior) ?? hollowFault(byBox, r.prior) : 'SAM box found nothing';
      if (byBox && !boxFault) {
        mask = withoutSpecks(byBox, Math.max(60, maskArea(byBox) * 0.03));
        source = 'sam-box';
      } else {
        const cut = colourCut(pixels, r.prior);
        const cutFault = cut ? thingMaskFault(cut, r.prior) ?? hollowFault(cut, r.prior) : 'nothing stands out from its surroundings';
        if (cut && !cutFault) {
          mask = cut;
          source = 'colour-cut';
          log(`${r.t.key}: ${boxFault}; cut it out of its box by colour`);
        } else {
          mask = rectMask(W, H, r.prior);
          source = r.fromSpark ? 'spark-box' : 'layout-box';
          log(`${r.t.key}: ${boxFault}; colour cut: ${cutFault}; the ${source} is its mask (coarse)`);
        }
      }
    }
    return { ...base, source, coarse: source === 'spark-box' || source === 'layout-box', px: maskArea(mask!), box: maskBox(mask!)!, mask: mask!, prior: r.spot.box ? clampRect(r.spot.box, W, H) : undefined };
  });
  return wholeThings(memo, place, painting, masked, log);
}

/** Did the parts found reach the edge of the box asked by (its top or a side, inside the frame)? Then there is more of it. */
export function reachesEdge(found: Rect, asked: Rect): boolean {
  const near = 6;
  return (asked[1] > 0 && found[1] - asked[1] < near) || (asked[0] > 0 && found[0] - asked[0] < near) || (asked[2] < W && asked[2] - found[2] < near);
}

/**
 * Things that stand or sit (not floors laid flat): a batch of box prompts per place, see wholeThing. Parts that
 * reach the edge of the box are asked once more by a box grown around them (fish piled high over a rim).
 */
async function wholeThings(memo: Memo, place: Place, painting: Buffer, masked: Array<ThingMask & { prior?: Rect }>, log: (line: string) => void): Promise<ThingMask[]> {
  const out: ThingMask[] = masked.map(({ prior: _, ...t }) => t);
  // A way out set in a wall (a door, an arch, a gate) has nothing in or on it: SAM by its grown box finds the house
  // around it, and the door, joined with part of the house, then reads far taller than a person can pass.
  const opening = (t: ThingMask) => t.kind === 'wall' && place.things.find((p) => p.key === t.key)?.role === 'exit';
  let asked = masked.filter((t) => t.source === 'sam-text' && t.kind !== 'walk-on' && t.kind !== 'flat' && !opening(t)).map((t) => ({ key: t.key, box: wholeBox(t.box, t.prior) }));
  for (let round = 0; round < 2 && asked.length; round++) {
    const boxed = await samBoxes(memo, `mask-whole${round ? round + 1 : ''}:${place.key}`, painting, asked.map((a) => a.box));
    const again: typeof asked = [];
    asked.forEach((a, i) => {
      const k = out.findIndex((t) => t.key === a.key);
      const t = out[k];
      const others = unionAll(W, H, out.filter((o) => o.key !== t.key).map((o) => o.mask));
      const whole = wholeThing(t.mask, boxed[i], others);
      if (whole.why) console.log(`  ${place.key}: ${t.key}: kept its mask, ${whole.why}`);
      if (!whole.added) return;
      const box = maskBox(whole.mask)!;
      out[k] = { ...t, mask: whole.mask, px: maskArea(whole.mask), box, whole: (t.whole ?? 0) + whole.added };
      if (reachesEdge(box, a.box)) again.push({ key: t.key, box: wholeBox(box, undefined) });
    });
    asked = again;
  }
  for (const t of out) if (t.whole) log(`${t.key}: SAM by name left parts of it out (what is in or on it); ${t.whole} px joined from SAM by its whole box`);
  return out;
}

/** Keeps a floor candidate to within one grid cell of Spark's marking and scores the agreement. */
export function scoreFloor(candidate: Mask, marked: Mask): { mask: Mask; iou: number } {
  const mask = intersect(candidate, dilate(marked, GRID));
  return { mask, iou: maskIou(mask, marked) };
}

export async function maskFloors(memo: Memo, place: Place, layout: Layout, marked: Record<string, string[]>, painting: Buffer, log: (line: string) => void): Promise<FloorMask[]> {
  const boxes = layout.floors.map((f) => cellsBox(marked[f.key]));
  const withBox = boxes.flatMap((b, i) => (b ? [{ i, box: clampRect([b[0] - GRID / 2, b[1] - GRID / 2, b[2] + GRID / 2, b[3] + GRID / 2], W, H) }] : []));
  const byBox = await samBoxes(memo, `floor-box:${place.key}`, painting, withBox.map((b) => b.box));

  return Promise.all(layout.floors.map(async (floor, i) => {
    const planned = polygonMask(W, H, floor.outline);
    const cells = cellsMask(marked[floor.key]);
    if (maskArea(cells) === 0) {
      log(`floor ${floor.key}: Spark marked no cells; using the layout outline (coarse)`);
      return { key: floor.key, source: 'layout' as const, coarse: true, px: maskArea(planned), iouCells: 0, iouLayout: 1, mask: planned };
    }
    const found = await samFind(memo, { label: `floor:${place.key}/${floor.key}`, image: painting, prompt: floor.key.replace(/-/g, ' ') });
    const candidates: { source: MaskSource; mask: Mask }[] = [
      ...found.map((f) => ({ source: 'sam-text' as const, mask: f.mask })),
      ...(found.length > 1 ? [{ source: 'sam-text' as const, mask: unionAll(W, H, found.map((f) => f.mask)) }] : []),
    ];
    const boxed = byBox[withBox.findIndex((b) => b.i === i)];
    if (boxed) candidates.push({ source: 'sam-box', mask: boxed });
    const scored = candidates.map((c) => ({ ...c, ...scoreFloor(c.mask, cells) })).sort((a, b) => b.iou - a.iou);
    const best = scored[0];
    if (best && best.iou >= 0.3) {
      return { key: floor.key, source: best.source, coarse: false, px: maskArea(best.mask), iouCells: best.iou, iouLayout: maskIou(best.mask, planned), mask: best.mask };
    }
    log(`floor ${floor.key}: best SAM candidate agrees ${(best?.iou ?? 0).toFixed(2)} with Spark's cells; using the cells (coarse)`);
    return { key: floor.key, source: 'spark-cells' as const, coarse: true, px: maskArea(cells), iouCells: 1, iouLayout: maskIou(cells, planned), mask: cells };
  }));
}
