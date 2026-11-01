// The painted lights alive (src/play/glow.ts): a soft halo added over each light that breathes, flickers or
// twinkles, and a lighthouse lamp's beam sweeping round, flaring when it turns towards us. Drawn with 'lighter'
// over the painting and its cards, so it only ever adds light, never covers what is painted.
import { beamAngle, glowLevel, type Glow } from '../src/play/glow.ts';
import { hashSeed } from '../src/play/weather.ts';

type Shift = (y: number) => [number, number];

/** #rrggbb as "r,g,b" for rgba() strings. */
const rgb = (hex: string) => {
  const n = parseInt(hex.replace('#', '').slice(0, 6).padEnd(6, 'f'), 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
};

export class GlowFx {
  private time = 0;
  /** Far lights twinkle as a few sparks spread round their point, fixed per light. */
  private readonly sparks: Array<Array<[number, number, number]>>;

  /** Each lit light's own bright paint (a lantern's glass, a lit window), cut from the painting: drawn over itself
   * in time with the light, so the painted lamp itself flickers and flares, not only a halo laid over it. */
  private readonly lit: Array<{ canvas: HTMLCanvasElement; x: number; y: number } | undefined>;

  private readonly glows: Glow[];

  constructor(planned: Glow[], private readonly H: number, painting?: CanvasImageSource & { width: number; height: number }, wet?: Uint8Array, cards: number[][] = []) {
    // The planned lights, then every other light Muse painted (a market's strings of lanterns, candle boats, lit
    // windows), found in the painting itself: each flickers on its own phase too.
    this.glows = painting ? [...planned, ...paintedLights(painting, planned, wet, cards)] : planned;
    const glows = this.glows;
    this.lit = glows.map((g) => (painting && g.kind !== 'twinkle' && g.kind !== 'beam' ? brightPaint(painting, g, H) : undefined));
    this.sparks = glows.map((g) => {
      let h = hashSeed(g.key);
      const r = () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0) % 1000) / 1000;
      return g.kind === 'twinkle' ? Array.from({ length: 7 }, () => [(r() - 0.5) * 90, (r() - 0.5) * 22, r() * 6.28] as [number, number, number]) : [];
    });
  }

  step(dt: number) {
    this.time += dt;
  }

  draw(ctx: CanvasRenderingContext2D, shift: Shift) {
    const t = this.time;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    this.glows.forEach((g, i) => {
      const [sx, sy] = shift(g.y);
      const x = g.x + sx;
      const y = g.y + sy;
      // Nearer lights (lower in the picture) are bigger.
      const near = Math.max(0, Math.min(1, g.y / this.H));
      const level = glowLevel(g, t);
      const c = rgb(g.colour);
      if (g.kind === 'twinkle') {
        for (const [dx, dy, ph] of this.sparks[i]) {
          const a = Math.max(0, Math.sin(t * 2.6 + ph * 3) * 0.5 + Math.sin(t * 0.9 + ph) * 0.5);
          halo(ctx, x + dx, y + dy, 3 + 4 * a, c, 0.55 * a);
        }
        return;
      }
      if (g.kind === 'beam') {
        const a = beamAngle(g, t);
        // Seen from the side, the turning beam swings left and right; pointing at us it flares, away it is gone.
        const across = Math.cos(a);
        const towards = Math.sin(a);
        const reach = (260 + 520 * near) * Math.abs(across);
        if (reach > 8) {
          const end = x + Math.sign(across) * reach;
          const spread = 14 + 120 * Math.abs(across) * (0.4 + near);
          const grad = ctx.createLinearGradient(x, y, end, y);
          grad.addColorStop(0, `rgba(${c},${0.3 * (0.6 + 0.4 * towards * towards)})`);
          grad.addColorStop(0.5, `rgba(${c},${0.12 * (0.6 + 0.4 * towards * towards)})`);
          grad.addColorStop(1, `rgba(${c},0)`);
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.moveTo(x, y - 4);
          ctx.lineTo(end, y - spread);
          ctx.lineTo(end, y + spread);
          ctx.lineTo(x, y + 4);
          ctx.closePath();
          ctx.fill();
        }
        const flare = towards > 0 ? Math.pow(Math.max(0, 1 - Math.abs(across) * 2.5), 2) : 0;
        halo(ctx, x, y, (30 + 40 * near) * (1 + 1.4 * flare), c, 0.28 + 0.2 * level + 0.5 * flare);
        return;
      }
      const r = g.kind === 'window' ? 16 + 34 * near : g.kind === 'flame' ? 26 + 44 * near : 22 + 40 * near;
      const a = g.kind === 'flame' ? 0.42 : g.kind === 'window' ? 0.34 : 0.3;
      // The light thrown round: a wide faint spill on the walls and the ground, rising and falling with the light.
      const found = g.key.startsWith('painted-');
      if (!found) halo(ctx, x, y, r * (2.6 + 0.5 * level), c, (g.kind === 'window' ? 0.07 : 0.11) * (0.3 + level));
      const lit = this.lit[i];
      if (lit) {
        // The lamp's own paint over itself: brighter on a flare, gone back to the painting on a dip. A flame's
        // tongue leans a little with its flicker.
        const lean = g.kind === 'flame' ? (level - 0.5) * 3 * (0.5 + near) : 0;
        ctx.globalAlpha = Math.max(0, Math.min(1, (g.kind === 'window' ? 0.45 : found ? 0.5 : 0.7) * (level - 0.25)));
        ctx.drawImage(lit.canvas, lit.x + sx + lean, lit.y + sy);
        ctx.globalAlpha = 1;
      }
      halo(ctx, x, y, r * (found ? 0.45 : 1) * (0.85 + 0.3 * level), c, a * (found ? 0.6 : 1) * (0.4 + level));
    });
    ctx.restore();
  }
}

/**
 * The painting's bright warm pixels round a light (a lantern's glass and flame, a window's panes), soft-edged:
 * what lights up when the light flares. Brighter than most of the picture and warmer than it is blue.
 */
function brightPaint(painting: CanvasImageSource & { width: number; height: number }, g: Glow, H: number) {
  const near = Math.max(0, Math.min(1, g.y / H));
  const R = Math.round(g.key.startsWith('painted-') ? 12 + 22 * near : g.kind === 'window' ? 22 + 40 * near : 30 + 50 * near);
  const x0 = Math.max(0, Math.round(g.x - R));
  const y0 = Math.max(0, Math.round(g.y - R));
  const w = Math.min(painting.width, Math.round(g.x + R)) - x0;
  const h = Math.min(painting.height, Math.round(g.y + R)) - y0;
  if (w < 4 || h < 4) return undefined;
  const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const c = canvas.getContext('2d', { willReadFrequently: true })!;
  c.drawImage(painting, x0, y0, w, h, 0, 0, w, h);
  const img = c.getImageData(0, 0, w, h);
  const px = img.data;
  let any = 0;
  for (let at = 0; at < px.length; at += 4) {
    const [r, gr, b] = [px[at], px[at + 1], px[at + 2]];
    const luma = 0.3 * r + 0.59 * gr + 0.11 * b;
    const warm = r - b;
    // Soft in and out: from luma 160 to 220, and only where red outweighs blue (lamplight, not a pale sky).
    const k = Math.max(0, Math.min(1, (luma - 160) / 60)) * Math.max(0, Math.min(1, (warm - 20) / 40));
    // And fading towards the patch's rim, so no square edge shows.
    const dx = (at / 4) % w + x0 - g.x;
    const dy = Math.floor(at / 4 / w) + y0 - g.y;
    const fall = Math.max(0, 1 - Math.hypot(dx, dy) / R) ** 0.7;
    px[at + 3] = Math.round(255 * k * fall);
    if (px[at + 3] > 40) any++;
  }
  if (any < 6) return undefined;
  c.putImageData(img, 0, 0);
  return { canvas, x: x0, y: y0 };
}

/** At most this many lights found in the painting come alive, the brightest first. */
const MAX_PAINTED = 48;

/**
 * The lights painted in the picture beyond the planned ones: warm, bright blobs (a lantern's paper, a candle, a
 * lit pane), found on a quarter-size copy. Each becomes a flame, or on water (a reflection) a flame too but drawn
 * over the shimmer; far from any planned light, so none is lit twice. No model call.
 */
function paintedLights(painting: CanvasImageSource & { width: number; height: number }, planned: Glow[], wet?: Uint8Array, cards: number[][] = []): Glow[] {
  const S = 4;
  const [w, h] = [Math.floor(painting.width / S), Math.floor(painting.height / S)];
  if (w < 8 || h < 8) return [];
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h }).getContext('2d', { willReadFrequently: true })!;
  c.drawImage(painting, 0, 0, w, h);
  const px = c.getImageData(0, 0, w, h).data;
  const hot = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const [r, g, b] = [px[i * 4], px[i * 4 + 1], px[i * 4 + 2]];
    if (0.3 * r + 0.59 * g + 0.11 * b > 190 && r - b > 70 && r > 230) hot[i] = 1;
  }
  const seen = new Uint8Array(w * h);
  const found: Array<Glow & { n: number }> = [];
  for (let start = 0; start < w * h; start++) {
    if (!hot[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let [n, sx, sy, sr, sg, sb] = [0, 0, 0, 0, 0, 0];
    while (stack.length) {
      const i = stack.pop()!;
      const [x, y] = [i % w, Math.floor(i / w)];
      n++; sx += x; sy += y; sr += px[i * 4]; sg += px[i * 4 + 1]; sb += px[i * 4 + 2];
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && hot[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    // A lantern or a pane, not a speck and not a whole sunset.
    if (n < 2 || n > 150) continue;
    const [x, y] = [(sx / n + 0.5) * S, (sy / n + 0.5) * S];
    // A light shines out of darker paint round it; a sunlit yellow wall does not.
    const r0 = Math.ceil(Math.sqrt(n)) + 3;
    let [ring, rn] = [0, 0];
    for (let a = 0; a < 16; a++) {
      const [qx, qy] = [Math.round(sx / n + r0 * Math.cos((a * Math.PI) / 8)), Math.round(sy / n + r0 * Math.sin((a * Math.PI) / 8))];
      if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
      const q = (qy * w + qx) * 4;
      ring += 0.3 * px[q] + 0.59 * px[q + 1] + 0.11 * px[q + 2];
      rn++;
    }
    const inner = (0.3 * sr + 0.59 * sg + 0.11 * sb) / n;
    if (!rn || inner - ring / rn < 70) continue;
    if (planned.some((g) => Math.hypot(g.x - x, g.y - y) < 40)) continue;
    // A light on a card slides with it; a glow laid at its painted place would part from it.
    if (cards.some((b) => x >= b[0] - 10 && x <= b[2] + 10 && y >= b[1] - 10 && y <= b[3] + 10)) continue;
    const hex = (v: number) => Math.round(Math.min(255, v / n)).toString(16).padStart(2, '0');
    const onWater = !!wet && wet[Math.round(y) * painting.width + Math.round(x)] > 100;
    found.push({ key: `painted-${onWater ? 'reflection' : 'lantern'}-${Math.round(x)}-${Math.round(y)}`, x, y, colour: `#${hex(sr)}${hex(sg)}${hex(sb)}`, kind: 'flame', n });
  }
  // Brightest (biggest) first, and not two on top of each other.
  found.sort((a, b) => b.n - a.n);
  const out: Glow[] = [];
  for (const f of found) {
    if (out.length >= MAX_PAINTED) break;
    if (out.some((o) => Math.hypot(o.x - f.x, o.y - f.y) < 18)) continue;
    out.push({ key: f.key, x: f.x, y: f.y, colour: f.colour, kind: f.kind });
  }
  return out;
}

/** A soft round glow: bright at its heart, fading to nothing at r. */
function halo(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, c: string, a: number) {
  if (a <= 0.01 || r <= 0.5) return;
  const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
  grad.addColorStop(0, `rgba(${c},${Math.min(1, a)})`);
  grad.addColorStop(0.35, `rgba(${c},${Math.min(1, a) * 0.45})`);
  grad.addColorStop(1, `rgba(${c},0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
}
