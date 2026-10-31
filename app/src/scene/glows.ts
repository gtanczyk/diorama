// Where the painted lights really are. layout.lights are guessed before the painting exists, and Muse paints a
// lamp where the picture wants it: a lighthouse lamp on its tower 170 px above the planned point, windows a
// row higher. The runtime glows (src/play/glow.ts) sat on the planned points, so a lighthouse beam swept out of
// a path or the water. Here each light is moved onto the bright spot it was painted as: a blob much brighter
// than what is round it, near its planned point (or on the thing its name says holds it). A light with no
// painted spot near it is left out: better no glow than one on nothing. Pixels only, no model call.
import sharp from 'sharp';
import { glowKind } from '../play/glow.ts';
import type { Mask } from '../image/mask.ts';

/** How far from its planned point a painted light is looked for (px). */
export const GLOW_REACH = 220;
/** A spot larger than this share of the frame is a lit wall or the sky, not a light. */
const MAX_SHARE = 0.015;
/** Glow pixels: this much brighter than the mean round them (0..255) and at least this bright. */
const CONTRAST = 34;
const BRIGHT = 150;
const STEP = 2;

export type Spot = { x: number; y: number; area: number; energy: number; box: [number, number, number, number]; rgb: [number, number, number]; peak: number };
export type PaintedGlow = { key: string; x: number; y: number };
type Light = { key: string; x: number; y: number; colour: string };

/** The bright spots of a painting, at full-frame coordinates. */
export async function brightSpots(painting: Buffer): Promise<{ spots: Spot[]; width: number; height: number }> {
  const meta = await sharp(painting).metadata();
  const width = meta.width!;
  const height = meta.height!;
  const w = Math.round(width / STEP);
  const h = Math.round(height / STEP);
  const { data } = await sharp(painting).removeAlpha().resize(w, h, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = 0.299 * data[i * 3] + 0.587 * data[i * 3 + 1] + 0.114 * data[i * 3 + 2];
  // Mean round each pixel (a 41 px window at full size) from an integral image.
  const sum = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += lum[y * w + x];
      sum[(y + 1) * (w + 1) + x + 1] = sum[y * (w + 1) + x + 1] + row;
    }
  }
  const r = Math.round(20 / STEP);
  const mean = (x: number, y: number) => {
    const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    return (sum[y1 * (w + 1) + x1] - sum[y0 * (w + 1) + x1] - sum[y1 * (w + 1) + x0] + sum[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
  };
  const lift = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const l = lum[y * w + x];
    const d = l - mean(x, y);
    if (l >= BRIGHT && d >= CONTRAST) lift[y * w + x] = d;
  }
  // Connected spots (8 neighbours), each weighted by how far it stands out.
  const seen = new Uint8Array(w * h);
  const spots: Spot[] = [];
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!lift[i] || seen[i]) continue;
    let n = 0, e = 0, sx = 0, sy = 0, cr = 0, cg = 0, cb = 0, peak = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    seen[i] = 1;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % w, y = (j - x) / w;
      const v = lift[j];
      n++; e += v; sx += x * v; sy += y * v; peak = Math.max(peak, lum[j]); cr += data[j * 3]; cg += data[j * 3 + 1]; cb += data[j * 3 + 2];
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const u = x + dx, v2 = y + dy;
        if (u < 0 || v2 < 0 || u >= w || v2 >= h) continue;
        const k = v2 * w + u;
        if (lift[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
      }
    }
    const area = n * STEP * STEP;
    if (area < 12 || area > MAX_SHARE * width * height) continue;
    spots.push({ x: (sx / e) * STEP + STEP / 2, y: (sy / e) * STEP + STEP / 2, area, energy: e * STEP * STEP, box: [x0 * STEP, y0 * STEP, (x1 + 1) * STEP, (y1 + 1) * STEP], rgb: [cr / n, cg / n, cb / n], peak });
  }
  return { spots, width, height };
}

/** #rrggbb: is it a warm light (lamp, fire, window), red well above blue? */
const warm = (hex: string) => {
  const n = parseInt(hex.replace('#', '').slice(0, 6).padEnd(6, 'f'), 16);
  return ((n >> 16) & 255) - (n & 255) >= 25;
};
/** A painted lamp, fire or lit window: warm and with a bright core. Moonlit white paint is neither. */
const lamplike = (s: Spot) => s.rgb[0] - s.rgb[2] >= 25 && s.peak >= 210;

/**
 * Each light on its painted spot. A warm light (most are: lamps, fires, windows) takes the strongest warm spot
 * near its planned point; one spot holds one light, the strongest, nearest pairs matched first. A beam is a
 * lighthouse lamp: higher spots are favoured, and with none near its point it is looked for over
 * the upper half of the painting. A light with no such spot keeps its planned point only
 * when that point is on a painted thing (`holders`: standing things and walls, the lamp is on the tower), and
 * is left out when it is on the floor, the water or the sky: that glow would light nothing painted. A cool
 * light (a white beam, the moon) is not looked for among the spots: pale paint lit by the moon looks the same.
 */
export function placeGlows(lights: Light[], spots: Spot[], holders: Mask[] = [], frameH = 896): PaintedGlow[] {
  const lamps = spots.map((s, si) => ({ s, si })).filter(({ s }) => lamplike(s));
  const pairs = lights.flatMap((l, li) => (warm(l.colour) ? lamps : []).flatMap(({ s, si }) => {
    const d = Math.hypot(s.x - l.x, s.y - l.y);
    if (d > GLOW_REACH) return [];
    // Strength grows slowly with size (a big lit wall should not beat a lamp), falls with distance.
    let score = Math.sqrt(s.energy) / (1 + (d / 120) ** 2);
    if (glowKind(l.key) === 'beam') score *= 1 + 3 * Math.max(0, 1 - s.y / frameH);
    return [{ li, si, score }];
  })).sort((a, b) => b.score - a.score);
  const taken = new Set<number>();
  const placed = new Map<number, PaintedGlow>();
  const place = (li: number, si: number) => {
    taken.add(si);
    placed.set(li, { key: lights[li].key, x: Math.round(spots[si].x), y: Math.round(spots[si].y) });
  };
  for (const p of pairs) if (!placed.has(p.li) && !taken.has(p.si)) place(p.li, p.si);
  // A lighthouse lamp is one of a kind and sometimes painted far from its planned point (across the picture):
  // with nothing near, the strongest free lamp in the upper half is it.
  lights.forEach((l, li) => {
    if (placed.has(li) || !warm(l.colour) || glowKind(l.key) !== 'beam') return;
    const best = lamps.filter(({ s, si }) => !taken.has(si) && s.y < frameH / 2)
      .map(({ s, si }) => ({ si, score: Math.sqrt(s.energy) * (1 - s.y / frameH) }))
      .sort((a, b) => b.score - a.score)[0];
    if (best) place(li, best.si);
  });
  return lights.flatMap((l, i) => {
    if (placed.has(i)) return [placed.get(i)!];
    const x = Math.round(l.x), y = Math.round(l.y);
    return holders.some((m) => x >= 0 && y >= 0 && x < m.width && y < m.height && m.bits[y * m.width + x]) ? [{ key: l.key, x, y }] : [];
  });
}

/** derive's step: the painted glows of a place, and a line for the log. */
export async function paintedGlows(painting: Buffer, lights: Light[], holders: Mask[]): Promise<{ glows: PaintedGlow[]; line: string }> {
  if (!lights.length) return { glows: [], line: '' };
  const { spots, height } = await brightSpots(painting);
  const glows = placeGlows(lights, spots, holders, height);
  const moved = glows.map((g) => { const l = lights.find((x) => x.key === g.key)!; const d = Math.round(Math.hypot(g.x - l.x, g.y - l.y)); return d ? `${g.key} moved ${d} px` : `${g.key} kept`; });
  const lost = lights.filter((l) => !glows.some((g) => g.key === l.key)).map((l) => l.key);
  return { glows, line: `glows on the painted lights: ${moved.join(', ') || 'none'}${lost.length ? `; no painted light for ${lost.join(', ')}` : ''}` };
}
