// masks: one SAM 3.1 mask per painted thing and per floor, checked against where Spark saw it.
// Things: SAM by phrase, the instances near Spark's box; a mask that fails the sanity gate is
// asked again with the box; if that fails too the box itself is the mask, marked coarse.
// Floors: SAM by name and by the box of Spark's cells; the candidate that agrees best with the
// cells wins; with none close enough the cells are the floor, marked coarse.
import { maskArea, type Mask } from '../image/mask.ts';
import { clampRect, dilate, intersect, maskBox, maskIou, polygonMask, rectArea, rectIou, rectMask, unionAll, withoutSpecks, type Rect } from '../image/raster.ts';
import type { Memo } from '../meta/memo.ts';
import { SAM_MAX_BOXES, samFind, type Box, type Found } from '../meta/sam.ts';
import type { Place } from '../world/schema.ts';
import { FRAME, type Layout } from './layout.ts';
import { cellsBox, cellsMask, GRID, type Kind, type Spots } from './locate.ts';

export type MaskSource = 'sam-text' | 'sam-box' | 'spark-box' | 'layout-box' | 'spark-cells' | 'layout';

export type ThingMask = { key: string; kind: Kind; phrase: string; source: MaskSource; coarse: boolean; px: number; box: Rect; mask: Mask };
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

/** The instances that belong to the thing: the one nearest its box, plus any others mostly inside it. */
export function pickInstances(found: Found[], prior: Rect): Mask | undefined {
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
  return withoutSpecks(mask, Math.max(60, maskArea(mask) * 0.03));
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
    const prior = sparkBox && rectArea(sparkBox) > 0 ? sparkBox : layoutBox(layout, t.key)!;
    let found = await samFind(memo, { label: `mask:${place.key}/${t.key}`, image: painting, prompt: spot.phrase });
    // SAM often knows the head noun when it misses the whole phrase ("brass oil can" -> "can").
    const head = spot.phrase.trim().split(/\s+/).at(-1)!;
    if (!pickInstances(found, prior) && head !== spot.phrase.trim()) {
      found = await samFind(memo, { label: `mask:${place.key}/${t.key}~${head}`, image: painting, prompt: head });
    }
    const mask = pickInstances(found, prior);
    const fault = mask ? thingMaskFault(mask, prior) : `SAM found no "${spot.phrase}"`;
    return { t, spot, prior, fromSpark: prior === sparkBox, mask, fault };
  }));

  const retry = tried.filter((r) => r.fault);
  const boxed = await samBoxes(memo, `mask-box:${place.key}`, painting, retry.map((r) => clampRect(r.prior, W, H)));
  return tried.map((r) => {
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
        mask = rectMask(W, H, r.prior);
        source = r.fromSpark ? 'spark-box' : 'layout-box';
        log(`${r.t.key}: ${boxFault}; the ${source} is its mask (coarse)`);
      }
    }
    return { ...base, source, coarse: source === 'spark-box' || source === 'layout-box', px: maskArea(mask!), box: maskBox(mask!)!, mask: mask! };
  });
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
