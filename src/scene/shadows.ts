// shadows: the painted cast shadows on the floor, and the light they tell of, so the hero casts a
// shadow the same way and darkens when standing in one. SAM finds no shadows in a painting (asked
// "shadow", "cast shadow", "shade": nothing), so they are cut by brightness: floor clearly darker
// than the lit floor around it, touching the base of a standing thing. The shape of each thing's
// shadow gives the direction and length. Spark says whether there is sun at all (fog darkens wet
// planks too), and gives the light itself when no thing has a shadow of its own.
import sharp from 'sharp';
import { z } from 'zod';
import { emptyMask, maskArea, type Mask } from '../image/mask.ts';
import { components, dilate, intersect, subtract, unionAll } from '../image/raster.ts';
import type { Memo } from '../meta/memo.ts';
import { askSparkJson } from '../meta/spark.ts';
import { FRAME } from './layout.ts';
import type { Blob } from './occluders.ts';

const { width: W, height: H } = FRAME;

/** Light as the runtime takes it: where shadows fall on screen (+y toward the viewer), how long they are
 * per px of the caster's height, and how much darker the floor is in shadow (0 none, 1 black). */
export type Light = { dir: [number, number]; length: number; strength: number };
export type CasterShadow = { thing: string; px: number; dir?: [number, number]; length?: number };
export type Shadows = { mask: Mask; light?: Light; casters: CasterShadow[]; source: 'casters' | 'spark' | 'none' };

/** Darker than this share of the lit floor around it is shadow. */
export const SHADOW_DARK = 0.74;
const REF_CELL = 16;
const REF_RADIUS = 6;

/** The painting's luma, lightly blurred so plank grain and pebbles don't count. */
export async function lumaOf(painting: Buffer): Promise<Uint8Array> {
  const raw = await sharp(painting).resize(W, H, { fit: 'fill' }).removeAlpha().blur(3).toColourspace('b-w').raw().toBuffer();
  return new Uint8Array(raw.buffer, raw.byteOffset, W * H);
}

/** How bright lit floor is around each pixel: a high percentile of the floor cells nearby. */
export function litFloor(luma: Uint8Array, floor: Mask): Float32Array {
  const cw = Math.ceil(W / REF_CELL), ch = Math.ceil(H / REF_CELL);
  const mean = new Float32Array(cw * ch).fill(-1);
  for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
    let sum = 0, n = 0;
    for (let y = cy * REF_CELL; y < Math.min(H, (cy + 1) * REF_CELL); y++) for (let x = cx * REF_CELL; x < Math.min(W, (cx + 1) * REF_CELL); x++) {
      if (floor.bits[y * W + x]) { sum += luma[y * W + x]; n++; }
    }
    if (n > 0.3 * REF_CELL * REF_CELL) mean[cy * cw + cx] = sum / n;
  }
  const ref = new Float32Array(cw * ch);
  for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
    const near: number[] = [];
    for (let dy = -REF_RADIUS; dy <= REF_RADIUS; dy++) for (let dx = -REF_RADIUS; dx <= REF_RADIUS; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x >= 0 && y >= 0 && x < cw && y < ch && mean[y * cw + x] >= 0) near.push(mean[y * cw + x]);
    }
    near.sort((a, b) => a - b);
    ref[cy * cw + cx] = near.length ? near[Math.floor(0.8 * (near.length - 1))] : 0;
  }
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[y * W + x] = ref[Math.floor(y / REF_CELL) * cw + Math.floor(x / REF_CELL)];
  return out;
}

/** Floor clearly darker than the lit floor around it, without thin cracks between planks. */
export function darkFloor(luma: Uint8Array, lit: Float32Array, floor: Mask): Mask {
  const dark = emptyMask(W, H);
  for (let i = 0; i < W * H; i++) if (floor.bits[i] && luma[i] < SHADOW_DARK * lit[i]) dark.bits[i] = 1;
  return intersect(dilate(dilate(dark, -2), 2), floor);
}

function centroid(m: Mask): [number, number] | undefined {
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < m.bits.length; i++) if (m.bits[i]) { sx += i % W; sy += Math.floor(i / W); n++; }
  return n ? [sx / n, sy / n] : undefined;
}

/** A thing's shadow measured from its base: where its middle points, and how far its far end is. */
export function measure(shadow: Mask, base: [number, number], height: number): { dir: [number, number]; length: number } | undefined {
  const mid = centroid(shadow);
  if (!mid) return undefined;
  const vx = mid[0] - base[0], vy = mid[1] - base[1];
  const reach = Math.hypot(vx, vy);
  // A dark ring around the foot is contact shade, not a cast shadow: it says nothing of the light.
  if (reach < 0.15 * height) return undefined;
  const dir: [number, number] = [vx / reach, vy / reach];
  const along: number[] = [];
  for (let i = 0; i < W * H; i++) if (shadow.bits[i]) along.push((i % W - base[0]) * dir[0] + (Math.floor(i / W) - base[1]) * dir[1]);
  along.sort((a, b) => a - b);
  return { dir, length: along[Math.floor(0.95 * (along.length - 1))] / height };
}

const SparkLight = z.object({ sunlit: z.boolean(), dx: z.number(), dy: z.number(), length: z.number() });

/** Is there sun, and which way would shadows fall? */
async function sparkLight(memo: Memo, label: string, painting: Buffer): Promise<Light | undefined> {
  const prompt = `This is a painted background for a 2D adventure game (${W}x${H} px, x right, y down). A person will be walking on its floor.
Is the scene lit by direct sun or another strong light that casts clear shadows (not fog, overcast or night without a lamp)? If it is, which way on the screen would a person's shadow fall from their feet, and how long would it be compared with their height?
Reply with JSON only: {"sunlit": true, "dx": 0.5, "dy": 0.5, "length": 0.8}  (dx, dy: direction on screen, +dy toward the viewer)`;
  const a = SparkLight.parse(await askSparkJson(memo, { label, prompt, images: [painting] }));
  const d = Math.hypot(a.dx, a.dy);
  if (!a.sunlit || d < 1e-3) return undefined;
  return { dir: [a.dx / d, a.dy / d], length: Math.min(3, Math.max(0.2, a.length)), strength: 0.35 };
}

/** The painted shadows on `floor` (ground the hero walks on, minus things) and the light behind them.
 * `casters` are the sharp standing blobs on the floor. */
export async function findShadows(memo: Memo, label: string, painting: Buffer, floor: Mask, casters: Blob[]): Promise<Shadows> {
  const luma = await lumaOf(painting);
  const lit = litFloor(luma, floor);
  const blobs = components(darkFloor(luma, lit, floor)).filter((c) => maskArea(c) >= 120);
  const kept: Mask[] = [];
  const measured: CasterShadow[] = [];
  for (const b of casters) {
    const height = b.baseY - b.box[1];
    if (height < 24) continue;
    // Only shadow at the thing's foot is its own: a lamp post rising through dark pebbles casts no pebbles.
    const foot = emptyMask(W, H);
    const from = Math.max(0, Math.round(b.baseY - Math.max(8, 0.1 * height)));
    for (let i = from * W; i < Math.min(H, b.baseY + 1) * W; i++) foot.bits[i] = b.mask.bits[i];
    const touch = dilate(foot, 8);
    const own = blobs.filter((c) => maskArea(intersect(c, touch)) >= 20);
    if (!own.length) continue;
    // A long shadow can run into the next one: only the part within a few heights of the base is this thing's.
    const near = emptyMask(W, H);
    const r = 4 * height, cx = (b.box[0] + b.box[2]) / 2;
    for (let y = Math.max(0, Math.round(b.baseY - r)); y < Math.min(H, b.baseY + r); y++) for (let x = Math.max(0, Math.round(cx - r)); x < Math.min(W, cx + r); x++) near.bits[y * W + x] = 1;
    const shadow = intersect(unionAll(W, H, own), near);
    kept.push(...own);
    // Measured from where the shadow meets the foot: a wide thing's base is a line, not its box's corner.
    const contact = centroid(intersect(shadow, touch)) ?? [cx, b.baseY];
    measured.push({ thing: b.key, px: maskArea(shadow), ...measure(shadow, contact, height) });
  }
  const mask = unionAll(W, H, kept);
  const directed = measured.filter((m) => m.dir);
  // Dark wet planks next to a teapot look like a shadow too: Spark says first whether there is sun at all.
  const told = await sparkLight(memo, `light:${label}`, painting);
  if (!told) return { mask: emptyMask(W, H), casters: measured, source: 'none' };
  if (!directed.length) return { mask: emptyMask(W, H), light: told, casters: measured, source: 'spark' };
  // The things agree on the light when their directions add up; if they don't, the biggest shadow wins.
  const weight = (m: CasterShadow) => Math.sqrt(m.px);
  const total = directed.reduce((s, m) => s + weight(m), 0);
  const sum = directed.reduce(([x, y], m) => [x + weight(m) * m.dir![0], y + weight(m) * m.dir![1]], [0, 0]);
  const agree = Math.hypot(sum[0], sum[1]) / total;
  const biggest = directed.reduce((a, b) => (b.px > a.px ? b : a));
  const dir: [number, number] = agree >= 0.8 ? [sum[0] / (agree * total), sum[1] / (agree * total)] : biggest.dir!;
  const lengths = directed.map((m) => m.length!).sort((a, b) => a - b);
  const length = agree >= 0.8 ? lengths[Math.floor(lengths.length / 2)] : biggest.length!;
  // Strength: how much darker the shadow is than the lit floor right around it.
  const ring = subtract(intersect(dilate(mask, 20), floor), mask);
  const median = (m: Mask, of: (i: number) => number) => {
    const v: number[] = [];
    for (let i = 0; i < W * H; i++) if (m.bits[i]) v.push(of(i));
    v.sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : 0;
  };
  const inShadow = median(mask, (i) => luma[i]);
  const around = Math.max(median(ring, (i) => luma[i]), median(mask, (i) => lit[i]));
  const strength = around > 0 ? Math.min(0.85, Math.max(0.1, 1 - inShadow / around)) : 0.35;
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return { mask, light: { dir: [round(dir[0]), round(dir[1])], length: round(Math.min(4, length)), strength: round(strength) }, casters: measured, source: 'casters' };
}
