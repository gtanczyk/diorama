// layers: the backdrop above the horizon (the far bank, hills, a castle) as flats one behind another, like the
// painted flats of a stage, so they slide at different speeds too. Spark names the bands far to near, SAM cuts
// each from the backdrop, and each flat grows a few px of its own pixels under the nearer ones, so a nearer
// flat that slides aside shows the farther one, not a hole. What no flat claims is the sky, filled in where
// the flats were.
import sharp from 'sharp';
import { z } from 'zod';
import { maskArea, maskToPng, emptyMask, type Mask } from '../image/mask.ts';
import { dilate, intersect, subtract, unionAll } from '../image/raster.ts';
import type { Memo } from '../meta/memo.ts';
import { samFind } from '../meta/sam.ts';
import { askSparkJson } from '../meta/spark.ts';
import type { Place } from '../world/schema.ts';
import { smearFill } from './backdrop.ts';
import { FRAME } from './layout.ts';

/** How far a flat grows under the nearer ones: more than two neighbouring flats ever slide apart. */
export const FLAT_GROW = 24;
/** Flats smaller than this are not worth a layer. */
const MIN_FLAT_PX = 2000;

const Bands = z.object({ bands: z.array(z.object({ phrase: z.string().min(2), what: z.string().optional() })).max(5) });

export type Flat = { phrase: string; png: Buffer; px: number; box: [number, number, number, number] };
export type Flats = { sky: Buffer; flats: Flat[] };

/** The flats above the horizon (farthest first) and the sky behind them; none when the picture has no far view. */
export async function farFlats(memo: Memo, place: Place, backdrop: Buffer, horizonY: number): Promise<Flats | undefined> {
  const [W, H]: [number, number] = [FRAME.width, FRAME.height];
  const prompt = `This is a painted backdrop of a game scene. The horizon is at y=${Math.round(horizonY)} of ${H} px.
List the separate bands of scenery above and around the horizon, from the FARTHEST to the NEAREST, the way a stage has painted flats one behind another: for example distant mountains, then hills, then a town or a castle on a hill, then a row of houses or trees across the water.
Do not list the sky, clouds, the sun, water, the ground the characters walk on, or anything in the foreground.
List 1 to 4 bands, each one a different distance. Give each a short noun phrase that an image segmentation model can search for ("distant mountains", "row of townhouses", "castle on a hill").
Answer only with JSON: {"bands": [{"phrase": "...", "what": "one short sentence"}]}`;
  const { bands } = Bands.parse(await askSparkJson(memo, { label: `flats:${place.key}`, prompt, images: [backdrop] }));
  if (!bands.length) return undefined;
  // Only what stands above (or just at) the horizon: below it the floor and the upright band move already.
  const above = emptyMask(W, H);
  above.bits.fill(1, 0, Math.min(H, Math.round(horizonY) + 6) * W);
  const found = await Promise.all(bands.map(async (b, i) => {
    // SAM often misses a long phrase ("castle on forested hill") and knows its head noun ("castle").
    let hits = await samFind(memo, { label: `flat:${place.key}/${i}`, image: backdrop, prompt: b.phrase });
    const head = headNoun(b.phrase);
    if (!hits.length && head !== b.phrase) hits = await samFind(memo, { label: `flat:${place.key}/${i}~${head}`, image: backdrop, prompt: head });
    return intersect(unionAll(W, H, hits.map((f) => f.mask)), above);
  }));
  // Each pixel belongs to the nearest flat that claims it.
  const owned: Mask[] = [];
  let taken = emptyMask(W, H);
  for (let i = found.length - 1; i >= 0; i--) {
    owned[i] = subtract(found[i], taken);
    taken = unionAll(W, H, [taken, owned[i]]);
  }
  let keep = owned.map((m, i) => ({ m, i, px: maskArea(m), box: boxOf(m) })).filter((f) => f.px >= MIN_FLAT_PX);
  // A small flat mostly inside a bigger, farther one (a castle on its hill) stays on it: it would slide off.
  for (let k = keep.length - 1; k > 0; k--) {
    const f = keep[k];
    const host = keep.slice(0, k).find((b) => b.px > f.px && inside(f.box, b.box) >= 0.4);
    if (!host) continue;
    host.m = unionAll(W, H, [host.m, f.m]);
    host.px += f.px;
    host.box = boxOf(host.m);
    keep = keep.filter((x) => x !== f);
  }
  if (!keep.length) return undefined;
  const rgb = new Uint8Array(await sharp(backdrop).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer());
  const all = unionAll(W, H, keep.map((f) => f.m));
  const flats: Flat[] = [];
  for (const [k, f] of keep.entries()) {
    // Grow only under nearer flats (and below the horizon line, which the floor covers), never out over the sky.
    const nearer = unionAll(W, H, keep.slice(k + 1).map((n) => n.m));
    const under = unionAll(W, H, [nearer, subtract(emptyMaskAll(W, H), above)]);
    const reach = unionAll(W, H, [f.m, intersect(dilate(f.m, FLAT_GROW), under)]);
    const filled = smearFill(rgb, W, H, subtract(reach, f.m), f.m);
    const alpha = await sharp(await maskToPng(reach)).blur(1).extractChannel(0).raw().toBuffer();
    const rgba = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      rgba[i * 4] = filled[i * 3];
      rgba[i * 4 + 1] = filled[i * 3 + 1];
      rgba[i * 4 + 2] = filled[i * 3 + 2];
      rgba[i * 4 + 3] = alpha[i];
    }
    const [x0, y0, x1, y1] = boxOf(reach);
    const png = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }).png().toBuffer();
    flats.push({ phrase: bands[f.i].phrase, png, px: f.px, box: [x0, y0, x1, y1] });
  }
  // The sky: the backdrop with every flat filled in from what is around it, so a flat that slides shows sky.
  const hole = dilate(all, 2);
  const sky = await sharp(smearFill(rgb, W, H, hole, subtract(above, hole)), { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return { sky, flats };
}

function emptyMaskAll(W: number, H: number): Mask {
  const m = emptyMask(W, H);
  m.bits.fill(1);
  return m;
}

/** "castle on a hill" → "castle", "row of townhouses" → "townhouses", "distant rolling hills" → "hills". */
export function headNoun(phrase: string): string {
  const words = phrase.trim().toLowerCase().split(/\s+/);
  const at = words.findIndex((w, k) => k > 0 && ['on', 'with', 'in', 'behind', 'above', 'near'].includes(w));
  return at > 0 ? words[at - 1] : words.at(-1)!;
}

function boxOf(m: Mask): [number, number, number, number] {
  let [x0, y0, x1, y1] = [m.width, m.height, 0, 0];
  for (let i = 0; i < m.bits.length; i++) {
    if (!m.bits[i]) continue;
    const x = i % m.width;
    const y = (i / m.width) | 0;
    [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x + 1), Math.max(y1, y + 1)];
  }
  return [x0, y0, x1, y1];
}

/** The share of box a that lies inside box b. */
function inside(a: number[], b: number[]): number {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return (w * h) / Math.max(1, (a[2] - a[0]) * (a[3] - a[1]));
}

/** How far the water texture reaches past the water's edge: more than the flow ever moves it in one cycle. */
export const WATER_PAD = 64;

/** The way the water flows on screen, a unit vector (downstream); [0, 0] for still water. */
export type Flow = [number, number];
export type Water = { tex: Buffer; mask: Buffer; box: [number, number, number, number]; phrase: string; flow: Flow };

const FlowAnswer = z.object({
  flows: z.boolean(),
  from: z.tuple([z.number(), z.number()]).optional(),
  to: z.tuple([z.number(), z.number()]).optional(),
});

/**
 * Which way the water runs on screen. A river or canal runs along its banks, so it is a line on the picture,
 * often into the depth (down the frame toward the viewer, or up toward a far bridge), not just sideways.
 * Spark reads it as an upstream and a downstream point; a lake, a harbour basin or the sea stays still.
 */
export async function flowOf(memo: Memo, place: Place, backdrop: Buffer, box: [number, number, number, number], hint?: string): Promise<Flow> {
  const prompt = `This is a painted game scene, ${FRAME.width}x${FRAME.height} px. There is ${place.key.replace(/-/g, ' ')} water in the box x ${box[0]}..${box[2]}, y ${box[1]}..${box[3]}.
Which way does the water run?${hint ? ` The author says: "${hint}". Follow that.` : ''} A river or a canal runs along its banks: follow the channel, which may lead into the depth of the picture (toward a far bridge or arch, or toward the viewer), not only left or right. Pick the more natural direction; when nothing shows it, water runs toward the viewer.
Answer with JSON only: {"flows": true, "from": [x, y], "to": [x, y]}, two points on the water in px, "from" upstream and "to" downstream, far apart along the channel. For still water (a pond, a lake, a harbour basin, the open sea) answer {"flows": false}.`;
  const a = FlowAnswer.parse(await askSparkJson(memo, { label: `water-flow:${place.key}`, prompt, images: [backdrop] }));
  if (!a.flows || !a.from || !a.to) return [0, 0];
  const [dx, dy] = [a.to[0] - a.from[0], a.to[1] - a.from[1]];
  const len = Math.hypot(dx, dy);
  return len < 1 ? [0, 0] : [Math.round((dx / len) * 1000) / 1000, Math.round((dy / len) * 1000) / 1000];
}

/**
 * The water of a place (a river, a canal, the sea) for the runtime to set flowing: its pixels, carried past
 * its edges from its own colours so a shifted copy never shows the bank, and its mask. None without water.
 * `notWater`: the floors and the cards, which SAM's water may take in when they are wet.
 */
/** How the author wants a place's depth: places/<key>/depth.json, set by the water_flow action, kept across rebuilds. */
export const Depth = z.object({
  /** auto: as Spark reads it; reverse: the other way round; still: the water does not flow. */
  flow: z.enum(['auto', 'reverse', 'still']).default('auto'),
  /** What the author said about the flow ("toward the bridge"), handed to Spark. */
  flowHint: z.string().optional(),
});
export type Depth = z.infer<typeof Depth>;

export async function waterSheet(memo: Memo, place: Place, backdrop: Buffer, notWater: Mask, depth: Depth = { flow: 'auto' }): Promise<Water | undefined> {
  const [W, H]: [number, number] = [FRAME.width, FRAME.height];
  let mask: Mask | undefined;
  let phrase = '';
  for (const p of ['water', 'river', 'sea']) {
    const hits = await samFind(memo, { label: `water:${place.key}/${p}`, image: backdrop, prompt: p });
    // SAM's "water" also takes wet planks and shiny cobbles: the floors and the standing things never flow.
    const m = subtract(unionAll(W, H, hits.map((f) => f.mask)), notWater);
    if (maskArea(m) >= 8000) [mask, phrase] = [m, p];
    if (mask) break;
  }
  if (!mask) return undefined;
  const [mx0, my0, mx1, my1] = boxOf(mask);
  // Carried past the edges on all sides: water running into the depth also moves up and down the frame.
  const box: [number, number, number, number] = [Math.max(0, mx0 - WATER_PAD), Math.max(0, my0 - WATER_PAD), Math.min(W, mx1 + WATER_PAD), Math.min(H, my1 + WATER_PAD)];
  const rgb = new Uint8Array(await sharp(backdrop).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer());
  // Everything in the box that is not water gets the water's colours, row by row from the nearest water.
  const reach = emptyMask(W, H);
  for (let y = box[1]; y < box[3]; y++) reach.bits.fill(1, y * W + box[0], y * W + box[2]);
  const filled = smearFill(rgb, W, H, subtract(reach, mask), mask);
  const region = { left: box[0], top: box[1], width: box[2] - box[0], height: box[3] - box[1] };
  const tex = await sharp(filled, { raw: { width: W, height: H, channels: 3 } }).extract(region).jpeg({ quality: 90 }).toBuffer();
  // The mask is shrunk a hair and feathered, so the flowing copy fades into the still painting at the banks.
  // The page cuts with the mask's alpha (destination-in), so it is white with the water as alpha.
  const alpha = await sharp(await maskToPng(dilate(mask, -2))).blur(2).extract(region).extractChannel(0).toBuffer();
  const soft = await sharp({ create: { width: region.width, height: region.height, channels: 3, background: '#ffffff' } }).joinChannel(alpha).png().toBuffer();
  const read = depth.flow === 'still' ? ([0, 0] as Flow) : await flowOf(memo, place, backdrop, [mx0, my0, mx1, my1], depth.flowHint).catch((error) => {
    console.log(`  ${place.key}: flow direction unknown, left to right (${error instanceof Error ? error.message.slice(0, 120) : error})`);
    return [1, 0] as Flow;
  });
  const flow: Flow = depth.flow === 'reverse' ? [-read[0] || 0, -read[1] || 0] : read;
  return { tex, mask: soft, box, phrase, flow };
}
