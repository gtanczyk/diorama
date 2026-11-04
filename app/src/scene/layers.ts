// layers: the backdrop above the horizon (the far bank, hills, a castle) as flats one behind another, like the
// painted flats of a stage, so they slide at different speeds too. Spark names the bands far to near, SAM cuts
// each from the backdrop, and each flat grows a few px of its own pixels under the nearer ones, so a nearer
// flat that slides aside shows the farther one, not a hole. What no flat claims is the sky, filled in where
// the flats were.
import sharp from 'sharp';
import { z } from 'zod';
import { maskArea, maskToPng, emptyMask, type Mask } from '../image/mask.ts';
import { components, dilate, intersect, polygonMask, subtract, union, unionAll } from '../image/raster.ts';
import type { Memo } from '../meta/memo.ts';
import { samFind } from '../meta/sam.ts';
import { askSparkJson } from '../meta/spark.ts';
import type { Place } from '../world/schema.ts';
import { smearFill } from './backdrop.ts';
import { FRAME } from './layout.ts';
import { cellsMask } from './locate.ts';

/** How far a flat grows under the nearer ones: more than two neighbouring flats ever slide apart. */
export const FLAT_GROW = 24;
/** A flat whose outline is soft (no colour step across it) along more than this share is a cut, not a silhouette. */
export const CUT_SHARE = 0.45;

/**
 * The share of a mask's outline (inside the frame, above the horizon line) where the paint on both sides is
 * alike: a silhouette against sky or fog steps in colour, a cut through one building does not. Measured 3 px
 * in and 3 px out across the outline, every other outline pixel.
 */
export function cutShare(rgb: Uint8Array, W: number, H: number, m: Mask, above: Mask): number {
  const D = 3;
  let soft = 0;
  let all = 0;
  for (let y = D; y < H - D; y++) {
    for (let x = D; x < W - D; x++) {
      const i = y * W + x;
      if (!m.bits[i] || !above.bits[i] || (x + y) % 2) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (m.bits[i + dy * W + dx]) continue;
        const a = (y - dy * D) * W + (x - dx * D);
        const b = (y + dy * D) * W + (x + dx * D);
        if (!above.bits[b]) break;
        const step = Math.abs(rgb[a * 3] - rgb[b * 3]) + Math.abs(rgb[a * 3 + 1] - rgb[b * 3 + 1]) + Math.abs(rgb[a * 3 + 2] - rgb[b * 3 + 2]);
        all++;
        if (step < 24) soft++;
        break;
      }
    }
  }
  return all ? soft / all : 0;
}

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
Inside a room (a bedroom, a kitchen, a hall, a cellar) its own walls, ceiling, doors and windows are not far scenery: list no bands for them. List bands there only for a far view seen through a big opening (a wide window onto a city, an open gate onto hills).
List no bands at all when there is no far view: {"bands": []}.
List up to 4 bands, each one a different distance. Give each a short noun phrase that an image segmentation model can search for ("distant mountains", "row of townhouses", "castle on a hill").
Answer only with JSON: {"bands": [{"phrase": "...", "what": "one short sentence"}]}`;
  const { bands } = Bands.parse(await askSparkJson(memo, { schema: Bands, label: `flats:${place.key}`, prompt, images: [backdrop] }));
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
  // A flat whose outline mostly runs through paint of the same colour cut a building or a stall in two (SAM
  // took half a pavilion with the row of houses): sliding, the two halves would part. Such a flat stays painted.
  keep = keep.filter((f) => cutShare(rgb, W, H, f.m, above) <= CUT_SHARE);
  if (!keep.length) return undefined;
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
  const a = FlowAnswer.parse(await askSparkJson(memo, { schema: FlowAnswer, label: `water-flow:${place.key}`, prompt, images: [backdrop] }));
  if (!a.flows || !a.from || !a.to) return [0, 0];
  const [dx, dy] = [a.to[0] - a.from[0], a.to[1] - a.from[1]];
  const len = Math.hypot(dx, dy);
  return len < 1 ? [0, 0] : [Math.round((dx / len) * 1000) / 1000, Math.round((dy / len) * 1000) / 1000];
}

/** How the author wants a place's depth: places/<key>/depth.json, set by the water_flow and fog_drift actions, kept across rebuilds. */
export const Depth = z.object({
  /** auto: as Spark reads it; reverse: the other way round; still: the water does not flow. */
  flow: z.enum(['auto', 'reverse', 'still']).default('auto'),
  /** What the author said about the flow ("toward the bridge"), handed to Spark. */
  flowHint: z.string().optional(),
  /** Which way the painted fog drifts (the fog_drift action): auto with the wind, left, right, or still. */
  fog: z.enum(['auto', 'left', 'right', 'still']).default('auto'),
  /** How fast it drifts, 0.25 (barely) .. 3 (rolling); 1 by default. */
  fogSpeed: z.number().min(0.25).max(3).optional(),
  /** 60 px grid cells (like C12) that are water SAM missed (water_area add), or are not water at all (water_area remove). */
  waterAdd: z.array(z.string()).default([]),
  waterRemove: z.array(z.string()).default([]),
});
export type Depth = z.infer<typeof Depth>;

/** A floor is taken to have swallowed the water when it holds this share of what SAM found, and is this much water itself. */
const SWALLOWED_WATER = 0.5;
const SWALLOWED_FLOOR = 0.3;
/** An added cell keeps SAM's water edge when SAM saw this much water in it; otherwise the whole cell flows. */
const ADDED_SEEN = 0.3;

/**
 * Where the water flows, from what SAM found: the cards (standing things) never flow, nor the floors, since
 * SAM's "water" also takes wet planks and shiny cobbles. But a floor that holds most of the water and is mostly
 * water itself (a "far bank" that took in the river in front of it) is wrong about it: the water wins there,
 * or only a strip at the bank would move. Then the author's cells (water_area): added cells flow (along SAM's
 * edge where it saw water there), removed ones never do. `swallowed` names the floors the water won over.
 */
export function waterMask(found: Mask, cards: Mask, floors: Array<{ key: string; mask: Mask }>, depth: Pick<Depth, 'waterAdd' | 'waterRemove'>): { mask: Mask; swallowed: string[] } {
  const { width: W, height: H } = found;
  const all = maskArea(found);
  const swallowed: string[] = [];
  const dry = floors.filter(({ key, mask }) => {
    const both = maskArea(intersect(mask, found));
    const takes = all > 0 && both / all >= SWALLOWED_WATER && both / Math.max(1, maskArea(mask)) >= SWALLOWED_FLOOR;
    if (takes) swallowed.push(key);
    return !takes;
  });
  const dryLand = dilate(unionAll(W, H, [...dry.map((f) => f.mask), cards]), 6);
  let mask = subtract(found, dryLand);
  for (const cell of depth.waterAdd) {
    const at = cellsMask([cell]);
    const seen = intersect(found, at);
    // A whole cell on the shore takes in a corner of the quay too: the floors and cards stay dry in it.
    mask = union(mask, maskArea(seen) >= ADDED_SEEN * maskArea(at) ? seen : subtract(at, dryLand));
  }
  if (depth.waterRemove.length) mask = subtract(mask, cellsMask(depth.waterRemove));
  return { mask, swallowed };
}

/**
 * The water of a place (a river, a canal, the sea) for the runtime to set flowing: its pixels, carried past
 * its edges from its own colours so a shifted copy never shows the bank, and its mask. None without water.
 * `cards` and `floors` may be wet in SAM's eyes: see waterMask.
 */
/** Words that say a place may show water, in English and Polish (world text follows the world's language). */
const WET = /\b(water|river|sea|ocean|lake|pond|pool|stream|canal|creek|brook|waves?|fountain|puddles?|harbou?r|port|quay|dock|pier|jetty|wharf|beach|shore|coast|bay|marsh|swamp|bridge|boats?|ship|ferry|rain|wet|flood|waterfall|spring|well)|wod|rzek|rzecz|morz|jezior|staw|strum|potok|kana[łl]|fontann|ka[łl]u[żz]|port|nabrze|przysta|pla[żz]|brzeg|most|[łl][óo]d[źz]|[łl]odz|statk|prom|deszcz|mokr|bagn|wodospad|studni|zdr[óo]j/i;

export function mayBeWet(place: Place): boolean {
  return WET.test([place.key, place.shows, place.mood, ...place.things.map((t) => JSON.stringify(t))].join(' '));
}

const WaterOutlines = z.object({ areas: z.array(z.object({ what: z.string().optional(), outline: z.array(z.tuple([z.number(), z.number()])).min(3) })).max(4) });

/**
 * Water SAM does not know: a sea of torn blue paper with crumpled white foam, felt waves, a woodcut river. Spark
 * outlines each body of water; the floors, cards and painted things are taken out of it after (see waterMask),
 * so a rough outline that runs over the quay still leaves the quay dry.
 */
export async function waterOutlines(memo: Memo, place: Place, backdrop: Buffer): Promise<{ mask: Mask; phrase: string } | undefined> {
  const [W, H]: [number, number] = [FRAME.width, FRAME.height];
  const prompt = `This is a painted game scene, ${W}x${H} px. Is there water in it (the sea, a river, a lake, a harbour, a pond), painted in any style: torn or folded paper waves with crumpled white foam, felt, cardboard, a woodcut?
Answer with JSON only: {"areas": [{"what": "stormy sea", "outline": [[x, y], ...]}]}, 8 to 20 points in px around the visible surface of each body of water (its waves and foam included; not the sky, a quay, a beach, rocks, boats or a waterfall), at most 4 areas; or {"areas": []} when there is none.`;
  const { areas } = WaterOutlines.parse(await askSparkJson(memo, { schema: WaterOutlines, label: `water-outline:${place.key}`, prompt, images: [backdrop] }));
  if (!areas.length) return undefined;
  return { mask: unionAll(W, H, areas.map((a) => polygonMask(W, H, a.outline))), phrase: areas.map((a) => a.what ?? 'water').join(' · ') };
}

export async function waterSheet(memo: Memo, place: Place, backdrop: Buffer, cards: Mask, floors: Array<{ key: string; mask: Mask }>, depth: Depth = Depth.parse({}), under?: Mask): Promise<Water | undefined> {
  const [W, H]: [number, number] = [FRAME.width, FRAME.height];
  let mask: Mask | undefined;
  let phrase = '';
  let swallowed: string[] = [];
  // SAM is asked about water only where the place could have some (its description, its things), or the author
  // marked it: a clockmaker's workshop paid three asks, one after another, to hear there is no sea in it.
  // What SAM finds must be water by itself: the author's cells (water_area) alone used to pass for it, and a paper
  // sea SAM never saw was left to them, still and blocky.
  const own = Depth.parse({});
  let found: Mask | undefined;
  for (const p of mayBeWet(place) ? ['water', 'river', 'sea'] : []) {
    const hits = await samFind(memo, { label: `water:${place.key}/${p}`, image: backdrop, prompt: p });
    const all = unionAll(W, H, hits.map((f) => f.mask));
    if (maskArea(waterMask(all, cards, floors, own).mask) >= 8000) [found, phrase] = [all, p];
    if (found) break;
  }
  // SAM saw no water where there may be some: a stylised sea (paper, felt) it does not call water. Spark outlines it.
  if (!found && mayBeWet(place)) {
    const drawn = await waterOutlines(memo, place, backdrop).catch((error) => {
      console.log(`  ${place.key}: no water outlined (${error instanceof Error ? error.message.slice(0, 120) : error})`);
      return undefined;
    });
    if (drawn && maskArea(waterMask(drawn.mask, cards, floors, own).mask) >= 8000) {
      [found, phrase] = [drawn.mask, drawn.phrase];
      console.log(`  ${place.key}: SAM saw no water; Spark outlined ${drawn.phrase}`);
    }
  }
  // Then the author's cells: added where SAM or Spark missed water, taken out where it is none.
  if (found || depth.waterAdd.length) {
    const m = waterMask(found ?? emptyMask(W, H), cards, floors, depth);
    if (maskArea(m.mask) > 0) [mask, swallowed, phrase] = [m.mask, m.swallowed, phrase || 'water'];
  }
  if (mask && swallowed.length) console.log(`  ${place.key}: the floor ${swallowed.join(', ')} took in the ${phrase}: it flows there anyway`);
  if (!mask) return undefined;
  const [mx0, my0, mx1, my1] = boxOf(mask);
  // Carried past the edges on all sides: water running into the depth also moves up and down the frame.
  const box: [number, number, number, number] = [Math.max(0, mx0 - WATER_PAD), Math.max(0, my0 - WATER_PAD), Math.min(W, mx1 + WATER_PAD), Math.min(H, my1 + WATER_PAD)];
  const raw = new Uint8Array(await sharp(backdrop).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer());
  // What swims in the water (fish set swimming as cards of their own) is painted out of it: the water beside them copied over them.
  const swum = under && intersect(dilate(under, 3), dilate(mask, 24));
  const rgb = swum && maskArea(swum) ? cloneFill(raw, W, H, swum) : raw;
  if (swum) mask = union(mask, swum);
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

/** How far the mist texture reaches past the fog's edge: more than it ever drifts in one cycle. */
export const MIST_PAD = 160;
/** Painted fog drifts only as a band: a frame-wide haze is the weather's mist (weather_set fog), not a layer. */
const MIST_MAX_SHARE = 0.55;

/** Painted fog for the runtime to set drifting: a veil of its colour shaped like it (reaching past its edges), and where it may show. */
export type Mist = { tex: Buffer; mask: Buffer; box: [number, number, number, number]; phrase: string; drift: -1 | 0 | 1 | null; speed: number };

const FogBands = z.object({ bands: z.array(z.object({ box: z.tuple([z.number(), z.number(), z.number(), z.number()]), what: z.string().optional() })).max(4) });

/** Soft wide streaks 0.35..1 over w x h, the same for the same place: smooth value noise, three octaves, stretched sideways. */
function wisps(key: string, w: number, h: number): Float32Array {
  let seed = [...key].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const out = new Float32Array(w * h).fill(0);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  let total = 0;
  for (const [cx, cy, amp] of [[280, 70, 1], [140, 36, 0.5], [70, 18, 0.25]]) {
    const [gw, gh] = [Math.ceil(w / cx) + 2, Math.ceil(h / cy) + 2];
    const grid = Float32Array.from({ length: gw * gh }, rand);
    for (let y = 0; y < h; y++) {
      const gy = y / cy;
      const [j, ty] = [Math.floor(gy), smooth(gy - Math.floor(gy))];
      for (let x = 0; x < w; x++) {
        const gx = x / cx;
        const [i, tx] = [Math.floor(gx), smooth(gx - Math.floor(gx))];
        const a = grid[j * gw + i] + (grid[j * gw + i + 1] - grid[j * gw + i]) * tx;
        const b = grid[(j + 1) * gw + i] + (grid[(j + 1) * gw + i + 1] - grid[(j + 1) * gw + i]) * tx;
        out[y * w + x] += amp * (a + (b - a) * ty);
      }
    }
    total += amp;
  }
  for (let k = 0; k < out.length; k++) out[k] = 0.35 + 0.65 * Math.min(1, Math.max(0, (out[k] / total - 0.3) / 0.45));
  return out;
}

/**
 * How foggy each pixel of a box is, 0..255: fog is pale and greyed, lighter than the box's own darker half. A
 * lit window or a white wall is pale too, but small: the blur after it keeps only wide soft veils.
 */
async function fogness(rgb: Uint8Array, W: number, H: number, [x0, y0, x1, y1]: number[]): Promise<Uint8Array> {
  const lumas: number[] = [];
  const out = new Uint8Array(W * H);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x += 3) {
    const i = (y * W + x) * 3;
    lumas.push(0.3 * rgb[i] + 0.59 * rgb[i + 1] + 0.11 * rgb[i + 2]);
  }
  lumas.sort((a, b) => a - b);
  const lo = lumas[Math.floor(lumas.length * 0.35)] ?? 0;
  const hi = Math.max(lo + 12, lumas[Math.floor(lumas.length * 0.95)] ?? 255);
  const [bw, bh] = [x1 - x0, y1 - y0];
  const f = new Float32Array(bw * bh);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * W + x) * 3;
    const [r, g, b] = [rgb[i], rgb[i + 1], rgb[i + 2]];
    const max = Math.max(r, g, b);
    const sat = max ? (max - Math.min(r, g, b)) / max : 0;
    const light = Math.min(1, Math.max(0, (0.3 * r + 0.59 * g + 0.11 * b - lo) / (hi - lo)));
    const grey = Math.min(1, Math.max(0, (0.6 - sat) / 0.35));
    // The box's rim fades out, so a band has no straight edge.
    const rim = Math.min(1, Math.min(x - x0, x1 - 1 - x) / (0.15 * bw), Math.min(y - y0, y1 - 1 - y) / (0.2 * bh));
    f[(y - y0) * bw + x - x0] = light * grey * rim;
  }
  // As foggy as the box's foggiest tenth: a night fog is blue and dim, yet it is the fog of that picture.
  const top = Math.max(0.15, [...f].sort((a, b) => a - b)[Math.floor(f.length * 0.9)]);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out[y * W + x] = Math.round(255 * Math.min(1, f[(y - y0) * bw + x - x0] / top));
  return new Uint8Array(await sharp(out, { raw: { width: W, height: H, channels: 1 } }).blur(8).extractChannel(0).raw().toBuffer());
}

/**
 * The fog or mist painted into a place (a bank over the land, haze round a far lighthouse), for the page to
 * drift: the painting holds it still, so a veil of the fog's own colour, shaped like its denser and lighter
 * patches, slides over it, and the wisps roll along. Only colour and density move, so the land under the fog
 * never slides or blurs. SAM cuts the fog when it knows it; it often does not (fog has no outline), so Spark
 * then names the boxes where fog bands lie, and the fog in them is read from the pixels. None without fog, or
 * when the whole picture is haze (that is the weather's mist). `notMist`: the standing things, which cover it
 * anyway; `floors`: where people walk, where the veil is thin, so they never wade in milk.
 */
export async function mistSheet(memo: Memo, place: Place, backdrop: Buffer, notMist: Mask, floors?: Mask, depth: Depth = Depth.parse({})): Promise<Mist | undefined> {
  if (depth.fog === 'still') return undefined;
  const [W, H]: [number, number] = [FRAME.width, FRAME.height];
  const fits = (px: number) => px >= 8000 && px <= MIST_MAX_SHARE * W * H;
  const rgb = new Uint8Array(await sharp(backdrop).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer());
  const density = new Uint8Array(W * H);
  let phrase = '';
  // Asked first, once: is there fog at all? Most places have none, and SAM was asked fog, mist and haze one after
  // another on every one of them (three calls and up to three minutes in the queue) before Spark said "clear".
  const fogPrompt = `This is a painted game scene, ${W}x${H} px. Is there fog, mist or haze painted in it: a bank of fog over the land or the water, mist round a far building, a veil over hills?
Answer with JSON only: {"bands": [{"box": [x0, y0, x1, y1], "what": "low fog over the dunes"}]}, one box in px round each band of fog (at most 4), or {"bands": []} when the air is clear. Not clouds high in the sky, not smoke from a chimney.`;
  const { bands } = FogBands.parse(await askSparkJson(memo, { schema: FogBands, label: `mist-bands:${place.key}`, prompt: fogPrompt, images: [backdrop] }));
  if (!bands.length) return undefined;
  for (const p of ['fog', 'mist', 'haze']) {
    const hits = await samFind(memo, { label: `mist:${place.key}/${p}`, image: backdrop, prompt: p });
    const m = subtract(unionAll(W, H, hits.map((f) => f.mask)), notMist);
    if (!fits(maskArea(m))) continue;
    const soft = new Uint8Array(await sharp(dilate(m, -6).bits.map((b) => b * 255), { raw: { width: W, height: H, channels: 1 } }).blur(14).extractChannel(0).raw().toBuffer());
    const f = await fogness(rgb, W, H, boxOf(m));
    for (let i = 0; i < density.length; i++) density[i] = (f[i] * soft[i]) / 255;
    phrase = p;
    break;
  }
  if (!phrase) {
    for (const b of bands) {
      const [x0, y0, x1, y1] = [Math.max(0, Math.round(b.box[0])), Math.max(0, Math.round(b.box[1])), Math.min(W, Math.round(b.box[2])), Math.min(H, Math.round(b.box[3]))];
      if (x1 - x0 < 40 || y1 - y0 < 20) continue;
      const f = await fogness(rgb, W, H, [x0, y0, x1, y1]);
      for (let i = 0; i < f.length; i++) if (f[i] > density[i]) density[i] = f[i];
    }
    phrase = bands.map((b) => b.what ?? 'fog').join(' · ');
  }
  for (let i = 0; i < density.length; i++) {
    if (notMist.bits[i]) density[i] = 0;
    else if (floors?.bits[i]) density[i] = Math.round(density[i] * 0.35);
  }
  const mask = emptyMask(W, H);
  for (let i = 0; i < density.length; i++) mask.bits[i] = density[i] > 40 ? 1 : 0;
  if (!phrase || !fits(maskArea(mask))) return undefined;
  const [mx0, my0, mx1, my1] = boxOf(mask);
  // Fog drifts sideways: the veil reaches past its left and right edges, a little above and below for the rim.
  const box: [number, number, number, number] = [Math.max(0, mx0 - MIST_PAD), Math.max(0, my0 - 32), Math.min(W, mx1 + MIST_PAD), Math.min(H, my1 + 32)];
  const region = { left: box[0], top: box[1], width: box[2] - box[0], height: box[3] - box[1] };
  // The fog's own colour: the painting where it is foggiest.
  const sum = [0, 0, 0, 0];
  for (let i = 0; i < density.length; i++) {
    const w = density[i] > 160 ? density[i] : 0;
    for (let c = 0; c < 3; c++) sum[c] += w * rgb[i * 3 + c];
    sum[3] += w;
  }
  const colour = sum[3] ? sum.slice(0, 3).map((v) => Math.round(v / sum[3])) : [220, 224, 230];
  // Lifted a little toward white, so the veil shows over its own fog.
  const veil = colour.map((v) => Math.round(v + (255 - v) * 0.25));
  // Wisps: the veil is the fog's density broken by soft wide streaks, so even an even fog has patches to drift.
  const wisp = wisps(place.key, region.width, region.height);
  const cut = Buffer.from((await sharp(density, { raw: { width: W, height: H, channels: 1 } }).extract(region).extractChannel(0).raw().toBuffer()).map((v, i) => Math.round(v * wisp[i])));
  const tex = await sharp({ create: { width: region.width, height: region.height, channels: 3, background: { r: veil[0], g: veil[1], b: veil[2] } } }).joinChannel(cut, { raw: { width: region.width, height: region.height, channels: 1 } }).png().toBuffer();
  // Where the veil may show: the fog grown and feathered wide, so drifting wisps fade out at its edge.
  const reach = await sharp(dilate(mask, 24).bits.map((b) => b * 255), { raw: { width: W, height: H, channels: 1 } }).blur(20).extract(region).extractChannel(0).raw().toBuffer();
  const soft = await sharp({ create: { width: region.width, height: region.height, channels: 3, background: '#ffffff' } }).joinChannel(reach, { raw: { width: region.width, height: region.height, channels: 1 } }).png().toBuffer();
  const drift = depth.fog === 'left' ? -1 : depth.fog === 'right' ? 1 : null;
  return { tex, mask: soft, box, phrase, drift, speed: depth.fogSpeed ?? 1 };
}

/** A plume bigger than this share of the frame is a cloud or a fog bank, not a chimney's smoke. */
const SMOKE_MAX_SHARE = 0.06;

export type Smoke = { png: Buffer; box: [number, number, number, number] };

/**
 * Painted smoke (from chimneys, a fire, a ship's funnel) to set curling: SAM finds it on the backdrop, and each
 * plume becomes a copy of the painting round it with a feathered edge. The page bends its rows sideways in a
 * wave that rises through it, more the higher it gets, so the smoke curls and drifts while its foot stays put.
 * Free when the place has none: one SAM call.
 */
export async function smokeSheet(memo: Memo, place: Place, backdrop: Buffer, notSmoke: Mask): Promise<Smoke[]> {
  const [W, H]: [number, number] = [FRAME.width, FRAME.height];
  const hits = await samFind(memo, { label: `smoke:${place.key}`, image: backdrop, prompt: 'smoke' });
  const all = subtract(unionAll(W, H, hits.map((f) => f.mask)), notSmoke);
  const rgba = await sharp(backdrop).resize(W, H, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
  const out: Smoke[] = [];
  for (const plume of components(all)) {
    const px = maskArea(plume);
    if (px < 300 || px > SMOKE_MAX_SHARE * W * H) continue;
    // The wave moves rows up to ~10 px: the copy reaches past the plume by that, and fades out at its rim.
    const reach = dilate(plume, 14);
    const [x0, y0, x1, y1] = boxOf(reach);
    const region = { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
    const alpha = await sharp(Buffer.from(reach.bits.map((b) => b * 255)), { raw: { width: W, height: H, channels: 1 } }).blur(6).extract(region).extractChannel(0).raw().toBuffer();
    const cut = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).extract(region).removeAlpha().joinChannel(alpha, { raw: { width: region.width, height: region.height, channels: 1 } }).png().toBuffer();
    out.push({ png: cut, box: [x0, y0, x1, y1] });
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * Painted boats on the water that are not cards (moored far off, candle boats on a river): SAM finds them on the
 * backdrop, each one touching the water becomes a feathered copy of the painting round it, and the page rocks
 * it on the swell a pixel or two, so a harbour's boats ride as one. Free beyond one SAM call.
 */
export async function floatSheet(memo: Memo, place: Place, backdrop: Buffer, notFloat: Mask, water?: Mask): Promise<Smoke[]> {
  if (!water) return [];
  const [W, H]: [number, number] = [FRAME.width, FRAME.height];
  const hits = await samFind(memo, { label: `floats:${place.key}`, image: backdrop, prompt: 'boat' });
  const all = subtract(unionAll(W, H, hits.map((f) => f.mask)), notFloat);
  const rgba = await sharp(backdrop).resize(W, H, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
  // A far boat sits on the water's far edge, where the water mask often stops short of the shore.
  const wetAround = dilate(water, 28);
  const out: Smoke[] = [];
  for (const boat of components(all)) {
    const px = maskArea(boat);
    if (px < 150 || px > 0.04 * W * H || maskArea(intersect(boat, wetAround)) < 0.15 * px) continue;
    const reach = dilate(boat, 5);
    const [x0, y0, x1, y1] = boxOf(reach);
    const region = { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
    const alpha = await sharp(Buffer.from(reach.bits.map((b) => b * 255)), { raw: { width: W, height: H, channels: 1 } }).blur(2).extract(region).extractChannel(0).raw().toBuffer();
    out.push({ png: await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).extract(region).removeAlpha().joinChannel(alpha, { raw: { width: region.width, height: region.height, channels: 1 } }).png().toBuffer(), box: [x0, y0, x1, y1] });
    if (out.length >= 24) break;
  }
  return out;
}

/**
 * Fills `hole` with paint copied from beside it: each piece of the hole takes the patch one hole-width (and a
 * little) to its left, else to its right, further out if that is hole too, as one piece, so the fill keeps the
 * paper's grain, the waves and the streaks around it instead of a blur or row-by-row smears. What no copy reaches
 * is smeared. Only `pieces` are filled; the rest of `hole` is only never copied from.
 */
export function cloneFill(rgb: Uint8Array, W: number, H: number, hole: Mask, pieces: Mask = hole): Uint8Array {
  const out = rgb.slice();
  const left = emptyMask(W, H);
  for (const piece of components(pieces)) {
    const [x0, , x1] = boxOf(piece);
    const step = x1 - x0 + 6;
    const tries = [-step, step, -2 * step, 2 * step, -3 * step, 3 * step];
    for (let i = 0; i < piece.bits.length; i++) {
      if (!piece.bits[i]) continue;
      const [x, y] = [i % W, (i / W) | 0];
      const dx = tries.find((d) => x + d >= 0 && x + d < W && !hole.bits[y * W + x + d]);
      if (dx === undefined) left.bits[i] = 1;
      else for (let c = 0; c < 3; c++) out[i * 3 + c] = rgb[(i + dx) * 3 + c];
    }
  }
  return maskArea(left) ? smearFill(out, W, H, left, subtract(emptyMaskAll(W, H), hole)) : out;
}

/**
 * Fills `hole` row by row with the paint mirrored across its edge (from the left of it, else the right): for a wide
 * hole beside a picture's part (the cliffs beside the clouds), whose edge runs much the same way down the rows, so
 * the mirror is one coherent reflection. What no row reaches is smeared.
 */
export function mirrorFill(rgb: Uint8Array, W: number, H: number, hole: Mask): Uint8Array {
  const out = rgb.slice();
  const left = emptyMask(W, H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      if (!hole.bits[row + x]) continue;
      const a = x;
      while (x < W && hole.bits[row + x]) x++;
      const b = x;
      // The paint beside the run, on whichever side there is more of it.
      let [l, r] = [0, 0];
      while (a - 1 - l >= 0 && !hole.bits[row + a - 1 - l]) l++;
      while (b + r < W && !hole.bits[row + b + r]) r++;
      const onLeft = l >= r;
      const span = onLeft ? l : r;
      for (let k = a; k < b; k++) {
        if (!span) {
          left.bits[row + k] = 1;
          continue;
        }
        // Mirrored back and forth over that paint, however wide the run is.
        const m = (onLeft ? k - a : b - 1 - k) % (2 * span);
        const off = m < span ? m : 2 * span - 1 - m;
        const src = onLeft ? a - 1 - off : b + off;
        for (let c = 0; c < 3; c++) out[(row + k) * 3 + c] = rgb[(row + src) * 3 + c];
      }
    }
  }
  return maskArea(left) ? smearFill(out, W, H, left, subtract(emptyMaskAll(W, H), hole)) : out;
}

/** A painted waterfall (any thing named so): the page sets its water falling. */
export const FALLING = /\b(water ?falls?|cascades?|falls|weir|spillway|wodospad\w*|kaskad\w*)\b/i;
/** Painted animals the page sets swimming or flying as small cards of their own. */
export const CRITTER = /\b(fish(es)?|goldfish|carp|trout|salmon|koi|eels?|dolphins?|whales?|seals?|ducks?|ducklings?|swans?|geese|goose|frogs?|birds?|gulls?|seagulls?|sparrows?|crows?|ravens?|pigeons?|doves?|swallows?|owls?|bats?|butterfl(y|ies)|dragonfl(y|ies)|jellyfish|ryb\w*|ptak\w*|mew\w*|kacz\w*|łabęd\w*|wron\w*|motyl\w*)\b/i;

export type Fall = { png: Buffer; box: [number, number, number, number] };
/**
 * Small things painted falling in a stream (code rain, falling letters, snowflakes, petals, sparks): the page
 * sets them falling, each column at its own pace, instead of rippling them like water.
 */
const STREAM_BITS = String.raw`letters?|code|symbols?|characters?|glyphs?|digits?|numbers?|numerals?|pixels?|bits|sparks?|petals?|leaves|snow\w*|stars?|confetti|runes?|litery|liter\w*|znak\w*|kod\w*|cyfr\w*|płatk\w*|liści\w*|gwiazd\w*|iskr\w*`;
export const STREAM = new RegExp(String.raw`\b(falling|raining|rain of|shower of|showers of|streams? of|stream of|cascad\w*|curtains? of|spadaj\w*|deszcz\w*)\b[\w\s-]{0,30}?\b(${STREAM_BITS})\b|\b(code|digital|matrix|data) rain\b|\b(${STREAM_BITS})[\s-]+(falling|raining|fall|rain|spadaj\w*)\b`, 'i');

export type Stream = Fall & { region: Buffer; backdrop: Buffer };

/** How far a stream's mask is closed over the glyphs SAM left out of it, px. */
const STREAM_CLOSE = 16;

/**
 * A painted stream of small falling things, cut out to fall on the page: what stands out of the paint behind it
 * (the glyphs: lighter or more coloured than the median around them) under `mask` is the sheet; the backdrop
 * gets the paint behind them in their place, so no still copy stays under the falling one. `region` is the
 * mask, softened, that the falling sheet is cut to. Undefined when nothing stands out.
 */
export async function streamSheet(backdrop: Buffer, painted: Mask, keepOut?: Mask): Promise<Stream | undefined> {
  const [W, H]: [number, number] = [FRAME.width, FRAME.height];
  // SAM finds the paint between the glyphs more often than the glyphs: closed, the mask holds them too.
  const closed = dilate(dilate(painted, STREAM_CLOSE), -STREAM_CLOSE);
  const mask = keepOut ? subtract(closed, keepOut) : closed;
  if (maskArea(mask) < 1500) return undefined;
  const rgb = new Uint8Array(await sharp(backdrop).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer());
  const bg = new Uint8Array(await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).median(15).raw().toBuffer());
  const glyph = emptyMask(W, H);
  let n = 0;
  for (let i = 0; i < W * H; i++) {
    if (!mask.bits[i]) continue;
    const d = [0, 1, 2].map((c) => rgb[i * 3 + c] - bg[i * 3 + c]);
    const luma = 0.3 * d[0] + 0.59 * d[1] + 0.11 * d[2];
    if (luma > 22 || Math.max(...d.map(Math.abs)) > 45) {
      glyph.bits[i] = 1;
      n++;
    }
  }
  if (n < 400) return undefined;
  const cut = intersect(dilate(glyph, 2), mask);
  const [x0, y0, x1, y1] = boxOf(mask);
  const region = { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
  const alpha = await sharp(await maskToPng(cut)).blur(0.8).extract(region).extractChannel(0).raw().toBuffer();
  const png = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).extract(region).joinChannel(alpha, { raw: { width: region.width, height: region.height, channels: 1 } }).png().toBuffer();
  const soft = await sharp(await maskToPng(mask)).blur(6).extract(region).extractChannel(0).raw().toBuffer();
  const regionPng = await sharp(Buffer.alloc(region.width * region.height * 3, 255), { raw: { width: region.width, height: region.height, channels: 3 } }).joinChannel(soft, { raw: { width: region.width, height: region.height, channels: 1 } }).png().toBuffer();
  // The paint behind the glyphs where they were: the median of the paint around them.
  const out = new Uint8Array(rgb);
  for (let i = 0; i < W * H; i++) if (cut.bits[i]) for (let c = 0; c < 3; c++) out[i * 3 + c] = bg[i * 3 + c];
  const filled = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  return { png, box: [x0, y0, x1, y1], region: regionPng, backdrop: filled };
}


/**
 * A painted waterfall for the page to set pouring: its pixels (from the backdrop) under its mask, feathered, over
 * its box. The page scrolls its ribbons down and churns foam at its foot, so only paint inside the fall moves.
 */
export async function fallSheet(backdrop: Buffer, mask: Mask): Promise<Fall | undefined> {
  const [W, H]: [number, number] = [FRAME.width, FRAME.height];
  if (maskArea(mask) < 1500) return undefined;
  const [x0, y0, x1, y1] = boxOf(mask);
  const region = { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
  const rgba = await sharp(backdrop).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const alpha = await sharp(await maskToPng(dilate(mask, -1))).blur(1.5).extract(region).extractChannel(0).raw().toBuffer();
  const png = await sharp(rgba, { raw: { width: W, height: H, channels: 3 } }).extract(region).joinChannel(alpha, { raw: { width: region.width, height: region.height, channels: 1 } }).png().toBuffer();
  return { png, box: [x0, y0, x1, y1] };
}

export type Critter = { png: Buffer; box: [number, number, number, number]; medium: 'water' | 'air'; facing: 1 | -1 };

/** Which way a painted animal looks: its eye (the brightest small spot) lies toward its head. Right when unsure. */
export function facingOf(rgb: Uint8Array, W: number, m: Mask): 1 | -1 {
  const [x0, y0, x1, y1] = boxOf(m);
  const lumas: number[] = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (m.bits[y * W + x]) lumas.push(0.3 * rgb[(y * W + x) * 3] + 0.59 * rgb[(y * W + x) * 3 + 1] + 0.11 * rgb[(y * W + x) * 3 + 2]);
  lumas.sort((a, b) => a - b);
  const bright = Math.max(170, lumas[Math.floor(lumas.length * 0.97)] ?? 255);
  let [sx, n] = [0, 0];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * W + x;
    if (m.bits[i] && 0.3 * rgb[i * 3] + 0.59 * rgb[i * 3 + 1] + 0.11 * rgb[i * 3 + 2] >= bright) [sx, n] = [sx + x, n + 1];
  }
  if (n < 4) return 1;
  return sx / n < (x0 + x1) / 2 - 0.08 * (x1 - x0) ? -1 : 1;
}

/**
 * Painted animals (fish in the river, gulls over the sea) as small cards of their own: each piece of the thing's
 * mask a feathered copy of the painting, in the water or the air, and the way it faces. The page sets them
 * swimming or flying; the backdrop and the water have them painted out (see cloneFill).
 */
export async function critterSheet(painting: Buffer, mask: Mask, water?: Mask): Promise<Critter[]> {
  const [W, H]: [number, number] = [FRAME.width, FRAME.height];
  const rgb = new Uint8Array(await sharp(painting).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer());
  const wetAround = water && dilate(water, 20);
  const out: Critter[] = [];
  for (const one of components(mask)) {
    const px = maskArea(one);
    if (px < 150 || px > 0.05 * W * H) continue;
    const reach = dilate(one, 2);
    const [x0, y0, x1, y1] = boxOf(reach);
    const region = { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
    const alpha = await sharp(await maskToPng(reach)).blur(1).extract(region).extractChannel(0).raw().toBuffer();
    const png = await sharp(Buffer.from(rgb), { raw: { width: W, height: H, channels: 3 } }).extract(region).joinChannel(alpha, { raw: { width: region.width, height: region.height, channels: 1 } }).png().toBuffer();
    const medium = wetAround && maskArea(intersect(one, wetAround)) >= 0.3 * px ? 'water' : 'air';
    out.push({ png, box: [x0, y0, x1, y1], medium, facing: facingOf(rgb, W, one) });
    if (out.length >= 12) break;
  }
  return out;
}

/** How fast each cloud band drifts against the one above it: the top band is nearest the eye and drifts fastest. */
const CLOUD_SPEEDS = [1, 0.74, 0.55, 0.42];
/** A band's rim (its torn bottom edge) is looked for this far above and below the row picked for it. */
const RIM_SEARCH = 28;
/** A rim is a real torn edge when its light-over-dark step averages this much luma along the way. */
export const RIM_MIN = 14;

/**
 * The path across the picture, one row per column between rows lo and hi, a row up or down per column at most,
 * along which `edge` (W wide) sums highest, and how strong it is on average along the way.
 */
export function rimPath(edge: Float32Array, W: number, lo: number, hi: number): { path: Float32Array; strength: number } {
  const n = hi - lo + 1;
  const score = new Float32Array(n * W);
  const from = new Int8Array(n * W);
  for (let r = 0; r < n; r++) score[r] = edge[(lo + r) * W];
  for (let x = 1; x < W; x++) {
    for (let r = 0; r < n; r++) {
      let [best, step] = [score[r * W + x - 1], 0];
      if (r > 0 && score[(r - 1) * W + x - 1] > best) [best, step] = [score[(r - 1) * W + x - 1], -1];
      if (r < n - 1 && score[(r + 1) * W + x - 1] > best) [best, step] = [score[(r + 1) * W + x - 1], 1];
      score[r * W + x] = best + edge[(lo + r) * W + x];
      from[r * W + x] = step;
    }
  }
  let r = 0;
  for (let k = 1; k < n; k++) if (score[k * W + W - 1] > score[r * W + W - 1]) r = k;
  const strength = score[r * W + W - 1] / W;
  const path = new Float32Array(W);
  for (let x = W - 1; x >= 0; x--) {
    path[x] = lo + r;
    r += from[r * W + x];
  }
  return { path, strength };
}

export type CloudBand = { png: Buffer; box: [number, number, number, number]; speed: number };
export type Clouds = { bands: CloudBand[]; clip: Buffer; keep?: Buffer; box: [number, number, number, number] };

const CloudArea = z.object({ areas: z.array(z.object({ outline: z.array(z.tuple([z.number(), z.number()])).min(3) })).max(3) });

/** Warm, saturated paint (a lamp's glow, a lighthouse's rays, the sun): light drawn over the sky, which stays put. */
function warm(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max > 110 && (max - min) / max > 0.35 && r >= b + 30 && g >= b;
}

/**
 * Where to cut the sky into bands: rows where many columns step from a light rim down to darker paper (the torn
 * white edge at the foot of a sheet of cloud), the strongest first, far enough apart. Row scores per y.
 */
export function bandCuts(score: Float32Array, y0: number, y1: number, most = 3): number[] {
  const span = y1 - y0;
  const gap = Math.max(50, span / 6);
  const smooth = new Float32Array(score.length);
  for (let y = 0; y < score.length; y++) {
    let [s, n] = [0, 0];
    for (let k = Math.max(0, y - 4); k <= Math.min(score.length - 1, y + 4); k++) [s, n] = [s + score[k], n + 1];
    smooth[y] = s / n;
  }
  const inside = [...smooth.slice(y0, y1)].sort((a, b) => a - b);
  const floor = 1.4 * (inside[Math.floor(inside.length / 2)] ?? 0) + 1e-6;
  const order = Array.from({ length: span }, (_, k) => y0 + k).filter((y) => y - y0 >= 40 && y1 - y >= 30 && smooth[y] > floor).sort((a, b) => smooth[b] - smooth[a]);
  const cuts: number[] = [];
  for (const y of order) {
    if (cuts.length >= most) break;
    if (cuts.every((c) => Math.abs(c - y) >= gap)) cuts.push(y);
  }
  return cuts.sort((a, b) => a - b);
}

/**
 * The painted clouds as bands, one behind another, for the page to drift with the wind at their own speeds,
 * like torn-paper flats on a stage. Spark outlines where the clouds are (SAM knows no paper cloud); the bands are
 * cut along the torn rims read from the pixels, each band's own rim its silhouette, and filled above it (mirrored
 * from its own paper) so a band never shows a gap under the one over it. `keep`: painted things in the sky
 * (wind swirls) that stay put; warm light (rays, glows) stays too. Cards (a lighthouse) are already out of the backdrop.
 */
export async function cloudSheet(memo: Memo, place: Place, backdrop: Buffer, notCloud: Mask, keep: Mask): Promise<Clouds | undefined> {
  const [W, H]: [number, number] = [FRAME.width, FRAME.height];
  const prompt = `This is a painted game scene, ${W}x${H} px. Are there clouds painted in its sky (soft, painted, or layered torn-paper clouds)?
Answer with JSON only: {"areas": [{"outline": [[x, y], ...]}]}, 8 to 20 points in px around the part of the picture that is clouds and sky (not hills, cliffs, rocks, trees, buildings, the sea or the ground), at most 3 areas; or {"areas": []} when no clouds are painted.`;
  const { areas } = CloudArea.parse(await askSparkJson(memo, { schema: CloudArea, label: `clouds:${place.key}`, prompt, images: [backdrop] }));
  if (!areas.length) return undefined;
  const area = subtract(unionAll(W, H, areas.map((a) => polygonMask(W, H, a.outline))), notCloud);
  if (maskArea(area) < 0.04 * W * H) return undefined;
  const [, sy0, , sy1] = boxOf(area);
  const rgb0 = new Uint8Array(await sharp(backdrop).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer());
  // What stays put in the sky: painted things there and warm light, a hair wider.
  const lit = emptyMask(W, H);
  for (let i = 0; i < W * H; i++) if (area.bits[i] && warm(rgb0[i * 3], rgb0[i * 3 + 1], rgb0[i * 3 + 2])) lit.bits[i] = 1;
  const pinned = intersect(dilate(unionAll(W, H, [keep, lit]), 3), area);
  // The band paper: the sky with what stays put, and all that is not cloud in the sky's rows, copied over from the clouds beside.
  const rows = emptyMask(W, H);
  rows.bits.fill(1, sy0 * W, sy1 * W);
  // A band drifts across the picture, so what lies beside the clouds in its rows (a cliff) slides into view too.
  const outside = subtract(rows, area);
  const rgb = mirrorFill(cloneFill(rgb0, W, H, union(pinned, outside), pinned), W, H, outside);
  const L = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) L[i] = 0.3 * rgb[i * 3] + 0.59 * rgb[i * 3 + 1] + 0.11 * rgb[i * 3 + 2];
  // A torn rim: light just above, darker paper just below.
  const edge = new Float32Array(W * H);
  const score = new Float32Array(H);
  for (let y = Math.max(2, sy0); y < Math.min(H - 3, sy1); y++) {
    let [s, n] = [0, 0];
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!area.bits[i]) continue;
      edge[i] = Math.max(0, L[i - 2 * W] - L[i + 3 * W]);
      [s, n] = [s + edge[i], n + 1];
    }
    score[y] = n > W * 0.2 ? s / n : 0;
  }
  const cuts = bandCuts(score, sy0, sy1);
  // Each cut follows its rim across the picture: the path of strongest light-over-dark steps near the cut's row,
  // a pixel up or down per column at most, so the band's edge is the paper's torn edge and never a notch. A cut
  // whose path finds no rim along most of the way (it runs through one sheet of paper) would tear it: none there.
  const paths = cuts.map((c) => rimPath(edge, W, Math.max(sy0 + 1, c - RIM_SEARCH), Math.min(sy1 - 2, c + RIM_SEARCH)));
  const rims = paths.filter((r) => r.strength >= RIM_MIN).map((r) => r.path.map((y) => y + 2));
  if (process.env.DIORAMA_DEBUG_CLOUDS) console.log(`  ${place.key}: cloud cuts ${cuts.join(', ')} rims ${paths.map((p) => p.strength.toFixed(1)).join(', ')}`);
  const tops = [new Float32Array(W).fill(sy0), ...rims];
  const bottoms = [...rims, new Float32Array(W).fill(sy1)];
  const bands: CloudBand[] = [];
  for (let k = 0; k < tops.length; k++) {
    const [top, bottom] = [tops[k], bottoms[k]];
    const yEnd = Math.min(H, Math.ceil(Math.max(...bottom)) + 2);
    const h = yEnd - sy0;
    if (h < 8) continue;
    const rgba = Buffer.alloc(W * h * 4);
    for (let x = 0; x < W; x++) {
      const [t, b] = [Math.round(top[x]), Math.round(bottom[x])];
      const tall = Math.max(1, b - t);
      for (let y = sy0; y < yEnd; y++) {
        // Above its top the band goes on in its own paper, mirrored back and forth, under the band above.
        let yy = y;
        if (y < t) {
          const m = (t - y) % (2 * tall);
          yy = m < tall ? t + m : b - 1 - (m - tall);
        }
        yy = Math.max(0, Math.min(H - 1, yy));
        const o = ((y - sy0) * W + x) * 4;
        rgba[o] = rgb[(yy * W + x) * 3];
        rgba[o + 1] = rgb[(yy * W + x) * 3 + 1];
        rgba[o + 2] = rgb[(yy * W + x) * 3 + 2];
        rgba[o + 3] = y < b ? 255 : y < b + 2 ? 120 : 0;
      }
    }
    bands.push({ png: await sharp(rgba, { raw: { width: W, height: h, channels: 4 } }).png().toBuffer(), box: [0, sy0, W, yEnd], speed: CLOUD_SPEEDS[Math.min(k, CLOUD_SPEEDS.length - 1)] });
  }
  // One band only (no rim found) still drifts as a whole.
  if (!bands.length) return undefined;
  const region = { left: 0, top: sy0, width: W, height: sy1 - sy0 };
  // Where the clouds may show (the page cuts with its alpha): not over the hills, cliffs or sea in front of them.
  const clipAlpha = await sharp(await maskToPng(area)).blur(1.5).extract(region).extractChannel(0).raw().toBuffer();
  const clipPng = await sharp({ create: { width: W, height: region.height, channels: 3, background: '#ffffff' } }).joinChannel(clipAlpha, { raw: { width: W, height: region.height, channels: 1 } }).png().toBuffer();
  let keepPng: Buffer | undefined;
  if (maskArea(pinned)) {
    const a = await sharp(await maskToPng(pinned)).blur(1.5).extract(region).extractChannel(0).raw().toBuffer();
    keepPng = await sharp(Buffer.from(rgb0), { raw: { width: W, height: H, channels: 3 } }).extract(region).joinChannel(a, { raw: { width: W, height: region.height, channels: 1 } }).png().toBuffer();
  }
  // Bottom band first: each band above lies over the one below it.
  return { bands: bands.reverse(), clip: clipPng, keep: keepPng, box: [0, sy0, W, sy1] };
}
