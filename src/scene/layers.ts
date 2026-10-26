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
