// The painted lights alive (src/play/glow.ts): a soft halo added over each light that breathes, flickers or
// twinkles, and a lighthouse lamp's beam sweeping round, flaring when it turns towards us. Drawn with 'lighter'
// over the painting and its cards, so it only ever adds light, never covers what is painted. The one exception
// is a lighthouse's own painted light paper (a burst of golden rays, a tissue beam): it is lifted off the painting
// as a card, its place filled from the sky round it, and turned behind the cards (drawBehind), so the painted
// light itself moves and no second beam is laid over a frozen one.
import { beamAngle, beamPaper, fillUnder, glowLevel, paperPose, type Glow } from '../src/play/glow.ts';
import { hashSeed } from '../src/play/weather.ts';

type Shift = (y: number) => [number, number];
type Painting = CanvasImageSource & { width: number; height: number };
/** A lighthouse's light paper as a card: its paper, the fill under it, where it may show, and a canvas to turn it on. */
type Paper = { card: HTMLCanvasElement; patch: HTMLCanvasElement; px: number; py: number; keep: HTMLCanvasElement; turned: HTMLCanvasElement; box: [number, number, number, number]; burst: boolean };
/** Light thrown on the rain falling through it: a pool round a point, by brightness 0..1. */
export type Pool = { x: number; y: number; r: number; c: string; a: number };

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
  /** Each planned beam's lifted light paper, by glow index. */
  private readonly papers: Array<Paper | undefined>;
  /** Where the lights shine on the falling rain this frame (drawAir reads it). */
  pools: Pool[] = [];

  constructor(planned: Glow[], private readonly H: number, painting?: Painting, wet?: Uint8Array, cards: number[][] = []) {
    const frame = painting && planned.some((g) => g.kind === 'beam') ? pixelsOf(painting) : undefined;
    this.papers = planned.map((g) => (frame && g.kind === 'beam' ? liftPaper(painting!, frame, g, planned.filter((o) => o.kind !== 'beam' && Math.hypot(o.x - g.x, o.y - g.y) > 120), wet) : undefined));
    const onPaper = (x: number, y: number) => this.papers.some((p) => p && x >= p.box[0] && y >= p.box[1] && x < p.box[2] && y < p.box[3] && p.keep.getContext('2d')!.getImageData(Math.floor(x - p.box[0]), Math.floor(y - p.box[1]), 1, 1).data[0] > 200);
    // The planned lights, then every other light Muse painted (a market's strings of lanterns, candle boats, lit
    // windows), found in the painting itself: each flickers on its own phase too. Not on a lighthouse's rays.
    this.glows = painting ? [...planned, ...paintedLights(painting, planned, wet, cards).filter((g) => !onPaper(g.x, g.y))] : planned;
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

  /** The lighthouse's light paper, turned: over the place's far paint, under its cards (the tower stands in front). */
  drawBehind(ctx: CanvasRenderingContext2D, shift: Shift) {
    this.papers.forEach((p, i) => {
      if (!p?.burst) return;
      const g = this.glows[i];
      const pose = paperPose(g, p.burst, this.time);
      const [sx, sy] = shift(g.y);
      ctx.drawImage(p.patch, p.px + sx, p.py + sy);
      const c = p.turned.getContext('2d')!;
      const [lx, ly] = [g.x - p.box[0], g.y - p.box[1]];
      c.clearRect(0, 0, p.turned.width, p.turned.height);
      c.save();
      c.globalAlpha = pose.alpha;
      c.translate(lx, ly);
      c.rotate(pose.turn);
      c.scale(pose.scale, pose.scale);
      c.translate(-lx, -ly);
      c.drawImage(p.card, 0, 0);
      c.restore();
      // Only over the sky, the sea and where the paper was: never over a boat's sail or the tower.
      c.globalCompositeOperation = 'destination-in';
      c.drawImage(p.keep, 0, 0);
      c.globalCompositeOperation = 'source-over';
      ctx.drawImage(p.turned, p.box[0] + sx, p.box[1] + sy);
    });
  }

  draw(ctx: CanvasRenderingContext2D, shift: Shift) {
    const t = this.time;
    const pools: Pool[] = [];
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
      const paper = this.papers[i];
      if (g.kind === 'beam' && paper) {
        // The painted paper is the beam (drawBehind); here only its glow: the paper lit up again, brighter as it
        // breathes or turns to us, and the lamp flaring.
        const pose = paperPose(g, paper.burst, t);
        const [sx2, sy2] = shift(g.y);
        if (paper.burst) {
          ctx.globalAlpha = Math.min(1, 0.22 + 0.35 * pose.flare + 0.2 * (level - 0.5));
          ctx.drawImage(paper.turned, paper.box[0] + sx2, paper.box[1] + sy2);
          ctx.globalAlpha = 1;
          pools.push({ x, y, r: 260, c, a: 0.35 + 0.3 * pose.flare });
        } else {
          // The painted beam lit by a wave running out of the lamp along it: its own paper, brightest at the wave.
          const dir = (paper.box[0] + paper.box[2]) / 2 < g.x ? -1 : 1;
          const far = dir < 0 ? g.x - paper.box[0] : paper.box[2] - g.x;
          const tc = paper.turned.getContext('2d')!;
          const lx = g.x - paper.box[0];
          tc.clearRect(0, 0, paper.turned.width, paper.turned.height);
          tc.globalCompositeOperation = 'source-over';
          tc.drawImage(paper.card, 0, 0);
          const band = tc.createLinearGradient(lx, 0, lx + dir * far, 0);
          const at = (u: number) => Math.max(0, Math.min(1, u));
          band.addColorStop(0, 'rgba(255,255,255,0.35)');
          band.addColorStop(at(pose.wave - 0.16), 'rgba(255,255,255,0.3)');
          band.addColorStop(at(pose.wave), 'rgba(255,255,255,1)');
          band.addColorStop(at(pose.wave + 0.12), 'rgba(255,255,255,0.3)');
          band.addColorStop(1, 'rgba(255,255,255,0.25)');
          tc.globalCompositeOperation = 'destination-in';
          tc.fillStyle = band;
          tc.fillRect(0, 0, paper.turned.width, paper.turned.height);
          tc.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = 0.6 + 0.3 * level;
          ctx.drawImage(paper.turned, paper.box[0] + sx2, paper.box[1] + sy2);
          ctx.globalAlpha = 1;
          if (pose.wave <= 1) pools.push({ x: x + dir * far * pose.wave, y, r: 200, c, a: 0.7 });
          for (let k = 1; k <= 4; k++) pools.push({ x: x + (dir * far * k) / 5, y, r: 120, c, a: 0.25 });
        }
        halo(ctx, x, y, (60 + 60 * near) * (1 + 1.6 * pose.flare), c, 0.35 + 0.25 * level + 0.5 * pose.flare);
        halo(ctx, x, y, (14 + 10 * near) * (1 + pose.flare), '255,250,235', 0.5 + 0.4 * pose.flare);
        pools.push({ x, y, r: 160 * (1 + pose.flare), c, a: 0.3 + 0.6 * pose.flare });
        return;
      }
      if (g.kind === 'beam') {
        const a = beamAngle(g, t);
        // Seen from the side, the turning beam swings left and right; pointing at us it flares, away it is gone.
        const across = Math.cos(a);
        const towards = Math.sin(a);
        // Even a far lighthouse throws its beam across the whole sky: it is the brightest thing in a night storm.
        const reach = (900 + 600 * near) * Math.abs(across);
        if (reach > 8) {
          const end = x + Math.sign(across) * reach;
          const spread = 26 + 150 * Math.abs(across) * (0.5 + near);
          const strength = 0.6 + 0.4 * towards * towards;
          // A wide soft cone, and a narrow white-hot core inside it, both blurred: light, not a cut-out wedge.
          // Soft as light without a blur filter (a canvas blur every frame halves the frame rate): each cone is
          // laid three times, a little wider and fainter each time, so its edge fades out.
          for (const [w, a0, a1, colour] of [[spread, 0.85, 0.34, c], [spread * 0.3, 0.8, 0.18, '255,250,235']] as const) {
            for (const [grow, share] of [[1.35, 0.25], [1.15, 0.3], [0.9, 0.45]] as const) {
              const grad = ctx.createLinearGradient(x, y, end, y);
              grad.addColorStop(0, `rgba(${colour},${a0 * strength * share})`);
              grad.addColorStop(0.45, `rgba(${colour},${a1 * strength * share})`);
              grad.addColorStop(1, `rgba(${colour},0)`);
              ctx.fillStyle = grad;
              ctx.beginPath();
              ctx.moveTo(x, y - 5 * grow);
              ctx.lineTo(end, y - w * grow);
              ctx.lineTo(end, y + w * grow);
              ctx.lineTo(x, y + 5 * grow);
              ctx.closePath();
              ctx.fill();
            }
          }
          for (let k = 1; k <= 6; k++) pools.push({ x: x + ((end - x) * k) / 6, y, r: 60 + (spread * k) / 4, c, a: 0.5 * (1 - k / 8) });
        }
        const flare = towards > 0 ? Math.pow(Math.max(0, 1 - Math.abs(across) * 2.5), 2) : 0;
        halo(ctx, x, y, (30 + 40 * near) * (1 + 1.4 * flare), c, 0.28 + 0.2 * level + 0.5 * flare);
        pools.push({ x, y, r: 120 * (1 + flare), c, a: 0.3 + 0.5 * flare });
        return;
      }
      const r = g.kind === 'window' ? 16 + 34 * near : g.kind === 'flame' ? 26 + 44 * near : 22 + 40 * near;
      const a = g.kind === 'flame' ? 0.42 : g.kind === 'window' ? 0.34 : 0.3;
      // The light thrown round: a wide faint spill on the walls and the ground, rising and falling with the light.
      const found = g.key.startsWith('painted-');
      const lamp = !found && g.kind !== 'window';
      if (!found) halo(ctx, x, y, r * (2.6 + 0.5 * level), c, (g.kind === 'window' ? 0.07 : 0.11) * (0.3 + level));
      // A lamp or a flame blooms: a wide soft light breathing round it, as if the wet air glowed.
      if (lamp) halo(ctx, x, y, r * (3.4 + 1.4 * level), c, 0.03 + 0.32 * level);
      const lit = this.lit[i];
      if (lit) {
        // The lamp's own paint over itself (its glass, a scribbled halo round it): brighter on a flare, gone back
        // to the painting on a dip, and a lamp's halo swelling and turning a little as it breathes, so its painted
        // rays shimmer. A flame's tongue leans a little with its flicker.
        const lean = g.kind === 'flame' ? (level - 0.5) * 3 * (0.5 + near) : 0;
        ctx.globalAlpha = Math.max(0, Math.min(1, (g.kind === 'window' ? 0.45 : found ? 0.5 : 1.1) * (level - 0.15)));
        if (lamp) {
          const ph = (hashSeed(g.key) % 628) / 100;
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(0.035 * Math.sin(t * 0.9 + ph));
          ctx.scale(1 + 0.09 * (level - 0.5), 1 + 0.09 * (level - 0.5));
          ctx.translate(-x, -y);
          ctx.drawImage(lit.canvas, lit.x + sx + lean, lit.y + sy);
          ctx.restore();
        } else ctx.drawImage(lit.canvas, lit.x + sx + lean, lit.y + sy);
        ctx.globalAlpha = 1;
      }
      halo(ctx, x, y, r * (found ? 0.45 : 1) * (0.85 + 0.3 * level), c, a * (found ? 0.6 : 1) * (0.4 + level));
      // A white-hot heart for a lamp, and its light on the rain round it.
      if (lamp) halo(ctx, x, y, r * 0.35 * (0.8 + 0.4 * level), '255,248,225', 0.2 + 0.35 * level);
      if (!found && g.kind !== 'window') pools.push({ x, y, r: r * (4.5 + 1.5 * level), c, a: 0.3 + 0.8 * level });
    });
    ctx.restore();
    this.pools = pools;
  }
}

/** The painting's pixels at full size. */
function pixelsOf(painting: Painting): ImageData {
  const c = Object.assign(document.createElement('canvas'), { width: painting.width, height: painting.height }).getContext('2d', { willReadFrequently: true })!;
  c.drawImage(painting, 0, 0);
  return c.getImageData(0, 0, painting.width, painting.height);
}

/**
 * A beam's light paper lifted off the painting (beamPaper): the paper as a card, and what goes under it
 * (fillUnder), so turned paper never leaves its painted twin behind.
 */
function liftPaper(painting: Painting, frame: ImageData, g: Glow, others: Glow[], wet?: Uint8Array): Paper | undefined {
  const found = beamPaper(frame.data, frame.width, frame.height, g, others);
  if (!found) return undefined;
  const [x0, y0, x1, y1] = found.box;
  const [w, h, W] = [x1 - x0, y1 - y0, frame.width];
  const canvas = (cw: number, ch: number) => Object.assign(document.createElement('canvas'), { width: cw, height: ch });
  const card = canvas(w, h);
  const keep = canvas(w, h);
  const cardImg = new ImageData(w, h);
  const keepImg = new ImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [o, i] = [(y * w + x) * 4, ((y + y0) * W + x + x0) * 4];
    // Only the light itself turns: warm paint, never the sea, foam or sky it was painted over.
    const [r, gr, b] = [frame.data[i], frame.data[i + 1], frame.data[i + 2]];
    const warm = Math.max(0, Math.min(1, (r - b - 45) / 45)) * Math.max(0, Math.min(1, (r + gr - 260) / 60));
    const al = found.alpha[y * w + x] * warm;
    cardImg.data.set([r, gr, b, Math.round(255 * al)], o);
    // Where turned paper may show: where paper was, and the blue of the sky and the sea.
    const open = al > 0.05 || frame.data[i + 2] > frame.data[i] + 8;
    keepImg.data.set([255, 255, 255, open ? 255 : 0], o);
  }
  card.getContext('2d')!.putImageData(cardImg, 0, 0);
  keep.getContext('2d', { willReadFrequently: true })!.putImageData(keepImg, 0, 0);
  // The fill under it: the paint round it, carried in across the paper (fillUnder). Only a burst is lifted.
  const patch = canvas(w, h);
  if (found.burst) {
    // The fill goes only where the light was painted, and not on water: the moving sea is drawn there already.
    const fill = fillUnder(frame.data, W, g, found) as Uint8ClampedArray<ArrayBuffer>;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (cardImg.data[o + 3] < 8 || (wet && wet[(y + y0) * W + x + x0] > 100)) fill[o + 3] = 0;
    }
    patch.getContext('2d')!.putImageData(new ImageData(fill, w, h), 0, 0);
  }
  return { card, patch, px: x0, py: y0, keep, turned: canvas(w, h), box: found.box, burst: found.burst };
}

/**
 * The painting's bright warm pixels round a light (a lantern's glass and flame, a window's panes), soft-edged:
 * what lights up when the light flares. Brighter than most of the picture and warmer than it is blue.
 */
function brightPaint(painting: CanvasImageSource & { width: number; height: number }, g: Glow, H: number) {
  const near = Math.max(0, Math.min(1, g.y / H));
  // A lamp's reach takes in the halo painted round it (a crayon scribble, painted rays), so that breathes too.
  const R = Math.round(g.key.startsWith('painted-') ? 12 + 22 * near : g.kind === 'window' ? 22 + 40 * near : g.kind === 'lamp' ? 60 + 100 * near : 30 + 50 * near);
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
    let [x0, y0, x1, y1] = [w, h, 0, 0];
    while (stack.length) {
      const i = stack.pop()!;
      const [x, y] = [i % w, Math.floor(i / w)];
      n++; sx += x; sy += y; sr += px[i * 4]; sg += px[i * 4 + 1]; sb += px[i * 4 + 2];
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x + 1), Math.max(y1, y + 1)];
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && hot[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    // A lantern or a pane, not a speck and not a whole sunset.
    if (n < 2 || n > 150) continue;
    // Nor a thin painted ray or streak: a light is round-ish, not a line.
    if (Math.max(x1 - x0, y1 - y0) > 4 && n / ((x1 - x0) * (y1 - y0)) < 0.3) continue;
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
