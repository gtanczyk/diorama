// The painted lights of a place (layout.lights) come alive: a window's glow breathes, a lantern or a fire
// flickers, a town's far lights twinkle, a lighthouse lamp turns its beam round. Read by the light's name, so
// any new world gets it with no extra step and no model call.
import { z } from 'zod';
import { hashSeed } from './weather.ts';

export type GlowKind = 'beam' | 'flame' | 'window' | 'twinkle' | 'lamp';

export const Glow = z.object({ key: z.string(), x: z.number(), y: z.number(), colour: z.string(), kind: z.enum(['beam', 'flame', 'window', 'twinkle', 'lamp']) });
export type Glow = z.infer<typeof Glow>;

// First match wins, the most telling words first: a lighthouse's windows are windows, not its beam, and a far lamp
// post is a lamp, not a town's twinkle.
const KINDS: Array<[GlowKind, RegExp]> = [
  ['beam', /\b(beam|beacon|searchlight)\b/],
  ['window', /\b(windows?|porthole|shopfront|doorway|glass)\b/],
  ['beam', /\blighthouse\b/],
  ['flame', /\b(fire|flame|candles?|torch|campfire|hearth|oven|brazier|lantern|embers?)\b/],
  ['lamp', /\b(lamps?|lamppost|streetlamp|streetlight)\b/],
  ['twinkle', /\b(town|city|village|distant|far|stars?|lights)\b/],
];

/** What kind of light a layout light is, by the words of its key ("hut-window", "lighthouse-lamp"). */
export function glowKind(key: string): GlowKind {
  const words = key.toLowerCase().replace(/[-_]+/g, ' ');
  return KINDS.find(([, re]) => re.test(words))?.[0] ?? 'lamp';
}

export function glowsOf(lights: Array<{ key: string; x: number; y: number; colour: string }>): Glow[] {
  return lights.map((l) => ({ ...l, kind: glowKind(l.key) }));
}

/**
 * How bright a glow is at time t, 0..1 around its rest of ~0.5: slow breathing for a window, a quick restless
 * flicker for a flame, short sparkles for far lights. Each light has its own phase, so a row of windows never
 * pulses together.
 */
export function glowLevel(g: Glow, t: number): number {
  const s = (hashSeed(g.key) % 1000) / 1000 * Math.PI * 2;
  switch (g.kind) {
    case 'flame': return 0.5 + 0.22 * Math.sin(t * 7.3 + s) + 0.14 * Math.sin(t * 12.9 + 2 * s) + 0.1 * Math.sin(t * 2.3 + s);
    case 'window': return 0.5 + 0.18 * Math.sin(t * 0.7 + s) + 0.08 * Math.sin(t * 2.9 + 3 * s) + (Math.sin(t * 0.21 + s) > 0.97 ? -0.25 : 0);
    case 'twinkle': return 0.5 + 0.3 * Math.sin(t * 3.7 + s) * Math.sin(t * 1.3 + 2 * s);
    case 'beam': return 0.5 + 0.15 * Math.sin(t * 1.1 + s);
    // A lamp breathes slowly and visibly, with a faint quick shiver in its paper.
    default: return 0.5 + 0.26 * Math.sin(t * 1.9 + s) + 0.07 * Math.sin(t * 6.3 + 2 * s) + 0.04 * Math.sin(t * 17 + s);
  }
}

/** A turning beam: its angle at time t (one turn per BEAM_TURN s, from the light's own phase). */
export const BEAM_TURN = 9;
export function beamAngle(g: Glow, t: number): number {
  return ((hashSeed(g.key) % 360) * Math.PI) / 180 + (t / BEAM_TURN) * Math.PI * 2;
}

/**
 * The light paper a lighthouse lamp was painted with: golden rays bursting round it, or a tissue-paper beam
 * reaching out of it. Bright warm paint joined to the ring round the lamp (not the lamp itself, which stays
 * painted), leaving out other lights' own halos. The runtime lifts it off the painting as a card and turns it,
 * so the painted light moves instead of a second beam being laid over a frozen one. Pixels only.
 *
 * `px` is RGBA at full frame size. The result's alpha is per pixel of `box` ([x0, y0, x1, y1), row-major).
 */
export type BeamPaper = { box: [number, number, number, number]; alpha: Float32Array; hole: Uint8Array; burst: boolean; share: number };
export function beamPaper(px: Uint8ClampedArray | Uint8Array, W: number, H: number, lamp: { x: number; y: number }, others: Array<{ x: number; y: number }> = []): BeamPaper | undefined {
  const k = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const [r, g, b] = [px[i * 4], px[i * 4 + 1], px[i * 4 + 2]];
    const luma = 0.3 * r + 0.59 * g + 0.11 * b;
    k[i] = Math.max(0, Math.min(1, (luma - 150) / 40)) * Math.max(0, Math.min(1, (r - b - 30) / 50));
  }
  const near = (x: number, y: number) => Math.hypot(x - lamp.x, y - lamp.y);
  const away = (x: number, y: number) => near(x, y) > LAMP_KEPT && !others.some((o) => Math.hypot(x - o.x, y - o.y) < 90);
  // Flood from the ring round the lamp through paper that is clearly lit (k over a quarter).
  const inside = new Uint8Array(W * H);
  const stack: number[] = [];
  const [cx, cy] = [Math.round(lamp.x), Math.round(lamp.y)];
  for (let y = Math.max(0, cy - SEED_RING); y < Math.min(H, cy + SEED_RING); y++) for (let x = Math.max(0, cx - SEED_RING); x < Math.min(W, cx + SEED_RING); x++) {
    const i = y * W + x;
    if (k[i] > 0.25 && near(x, y) < SEED_RING && away(x, y)) { inside[i] = 1; stack.push(i); }
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % W, y = (i - x) / W;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const u = x + dx, v = y + dy;
      if (u < 0 || v < 0 || u >= W || v >= H) continue;
      const j = v * W + u;
      if (!inside[j] && k[j] > 0.25 && away(u, v)) { inside[j] = 1; stack.push(j); }
    }
  }
  // Its soft rim too: the faint paper two pixels round what was found; and the hole it leaves wider still, taking
  // the paper's darker cut edge and its shadow.
  let [x0, y0, x1, y1, n] = [W, H, 0, 0, 0];
  const bins = new Float32Array(24);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!inside[y * W + x]) continue;
    n++;
    [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x + 1), Math.max(y1, y + 1)];
    bins[Math.floor(((Math.atan2(y - lamp.y, x - lamp.x) + Math.PI) / (2 * Math.PI)) * 24) % 24]++;
  }
  if (n < MIN_PAPER) return undefined;
  [x0, y0, x1, y1] = [Math.max(0, x0 - RIM), Math.max(0, y0 - RIM), Math.min(W, x1 + RIM), Math.min(H, y1 + RIM)];
  const bw = x1 - x0;
  const alpha = new Float32Array(bw * (y1 - y0));
  const hole = new Uint8Array(bw * (y1 - y0));
  // Distance to the paper (in pixels, by rows then columns: a square reach is near enough).
  const rows = new Uint8Array(bw * (y1 - y0)).fill(255);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    let d = 255;
    for (let dx = -RIM; dx <= RIM; dx++) if (x + dx >= 0 && x + dx < W && inside[y * W + x + dx]) d = Math.min(d, Math.abs(dx));
    rows[(y - y0) * bw + x - x0] = d;
  }
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    let d = 255;
    for (let dy = -RIM; dy <= RIM; dy++) if (y + dy >= y0 && y + dy < y1) d = Math.min(d, Math.max(Math.abs(dy), rows[(y + dy - y0) * bw + x - x0]));
    if (d > RIM || !away(x, y)) continue;
    const i = (y - y0) * bw + x - x0;
    hole[i] = 1;
    if (d <= 2) alpha[i] = Math.min(1, k[y * W + x] * 1.4);
  }
  // A burst spreads all round the lamp; a beam reaches out one way.
  const burst = [...bins].filter((b) => b > n * 0.015).length >= 12;
  return { box: [x0, y0, x1, y1], alpha, hole, burst, share: n / (W * H) };
}
/** The hole the paper leaves reaches this far past it (px). */
const RIM = 4;
/** The lamp itself (this far round its point) stays painted. */
const LAMP_KEPT = 22;
/** Light paper is looked for from this far round the lamp. */
const SEED_RING = 130;
/** Fewer lit pixels than this joined to the lamp is no painted light paper. */
const MIN_PAPER = 1500;

/** A painted beam sends a wave of light out along itself this often (s). */
export const BEAM_PULSE = 3;

/**
 * How a lighthouse's light paper stands at time t. A burst of rays is lifted off and turns a little to and fro,
 * breathing. A painted beam stays where it was painted (lifted, the long hole under it would show the painting
 * smeared) and pulses instead: a wave of light leaves the lamp with a flare and runs out along the beam to its end
 * (`wave`, 0 at the lamp .. 1 at the far end, beyond it gone).
 */
export function paperPose(g: Glow, burst: boolean, t: number): { turn: number; scale: number; alpha: number; flare: number; wave: number } {
  const s = (hashSeed(g.key) % 1000) / 1000 * Math.PI * 2;
  if (burst) {
    const breathe = Math.sin(t * 1.3 + s);
    return { turn: 0.12 * Math.sin(t * 0.42 + s), scale: 1 + 0.035 * breathe, alpha: 0.85 + 0.15 * breathe, flare: 0.2 * (1 + breathe), wave: -1 };
  }
  const wave = (((t + (s / (Math.PI * 2)) * BEAM_PULSE) % BEAM_PULSE) / BEAM_PULSE) * 1.4;
  return { turn: 0, scale: 1, alpha: 1, flare: Math.max(0, 1 - wave * 4) ** 2, wave };
}

/**
 * The paint under lifted light paper, filled from round it: each pixel of the hole takes the paint met turning
 * round the lamp to either side of the paper, at the same distance from it. Rays and beams come out of the lamp,
 * so this crosses them the short way and carries the clouds' and waves' own texture in, where a blur would leave
 * a soft smear. RGBA for `paper.box`, opaque only in the hole.
 */
export function fillUnder(px: Uint8ClampedArray | Uint8Array, W: number, lamp: { x: number; y: number }, paper: Pick<BeamPaper, 'box' | 'hole'>): Uint8ClampedArray {
  const [x0, y0, x1, y1] = paper.box;
  const bw = x1 - x0;
  const H = px.length / 4 / W;
  const out = new Uint8ClampedArray(bw * (y1 - y0) * 4);
  const open = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && !(x >= x0 && y >= y0 && x < x1 && y < y1 && paper.hole[(y - y0) * bw + x - x0]);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (!paper.hole[(y - y0) * bw + x - x0]) continue;
    const r = Math.max(1, Math.hypot(x - lamp.x, y - lamp.y));
    const a0 = Math.atan2(y - lamp.y, x - lamp.x);
    const sides: Array<[number, number]> = [];
    for (const dir of [1, -1]) {
      for (let s = 1; s <= Math.min(600, r * 0.6); s++) {
        const a = a0 + (dir * s) / r;
        const [u, v] = [Math.round(lamp.x + r * Math.cos(a)), Math.round(lamp.y + r * Math.sin(a))];
        if (u < 0 || v < 0 || u >= W || v >= H) break;
        if (open(u, v)) { sides.push([(v * W + u) * 4, s]); break; }
      }
    }
    const o = ((y - y0) * bw + x - x0) * 4;
    if (!sides.length) { out.set([px[(y * W + x) * 4], px[(y * W + x) * 4 + 1], px[(y * W + x) * 4 + 2], 255], o); continue; }
    // Nearer side counts more, so the two meet smoothly in the middle.
    let [r0, g0, b0, wt] = [0, 0, 0, 0];
    for (const [i, s] of sides) { const k = 1 / s; r0 += px[i] * k; g0 += px[i + 1] * k; b0 += px[i + 2] * k; wt += k; }
    out.set([r0 / wt, g0 / wt, b0 / wt, 255], o);
  }
  return out;
}
