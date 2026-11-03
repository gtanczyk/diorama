// living: the painted sea's swell and surf, waterfalls pouring, animals swimming and flying, and cloud bands
// drifting, drawn on the page's canvas. The numbers come from src/play/living.ts.
import { leapHeight, shorePoints, swellAt, swimAt } from '../src/play/living.ts';

type Box = [number, number, number, number];
type Shift = (y: number) => [number, number];

const canvasOf = (w: number, h: number) => Object.assign(document.createElement('canvas'), { width: Math.max(1, w), height: Math.max(1, h) });
const pixelsOf = (img: CanvasImageSource, w: number, h: number) => {
  const c = canvasOf(w, h).getContext('2d', { willReadFrequently: true })!;
  c.drawImage(img, 0, 0, w, h);
  return c.getImageData(0, 0, w, h);
};
/** Seeded 0..1, the same every run. */
const rand = (i: number, salt = 0) => {
  const v = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

/**
 * The sea's surf: its foam (the light, greyish paint in the water texture: crumpled paper, white crests) as a layer
 * of its own that slides over the swell, and where the water meets land, rock or a hull, puffs of foam and spray.
 */
export class Surf {
  readonly foam: HTMLCanvasElement;
  private readonly shore: Array<{ x: number; y: number; nx: number; ny: number }>;
  private readonly colour: string;

  constructor(tex: HTMLImageElement, mask: HTMLImageElement, readonly box: Box, backdrop?: HTMLImageElement) {
    const [w, h] = [box[2] - box[0], box[3] - box[1]];
    const px = pixelsOf(tex, w, h);
    const foam = new ImageData(w, h);
    let [r, g, b, n] = [0, 0, 0, 0];
    for (let i = 0; i < w * h; i++) {
      const [R, G, B] = [px.data[i * 4], px.data[i * 4 + 1], px.data[i * 4 + 2]];
      const max = Math.max(R, G, B);
      const sat = max ? (max - Math.min(R, G, B)) / max : 0;
      const light = 0.3 * R + 0.59 * G + 0.11 * B;
      const a = Math.max(0, Math.min(1, (light - 150) / 50)) * Math.max(0, Math.min(1, (0.4 - sat) / 0.2));
      foam.data.set([R, G, B, Math.round(255 * a)], i * 4);
      if (a > 0.8) [r, g, b, n] = [r + R, g + G, b + B, n + 1];
    }
    this.foam = canvasOf(w, h);
    this.foam.getContext('2d')!.putImageData(foam, 0, 0);
    this.colour = n ? `${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)}` : '236,240,246';
    // Where the mask ends but the paint beyond is the same sea (a strip the mask missed), no surf: the dry side
    // must look like something else (planks, rock, a hull).
    const bg = backdrop && pixelsOf(backdrop, backdrop.width, backdrop.height);
    const paint = (x: number, y: number) => {
      const [X, Y] = [Math.max(0, Math.min(bg!.width - 1, Math.round(box[0] + x))), Math.max(0, Math.min(bg!.height - 1, Math.round(box[1] + y)))];
      return bg!.data.slice((Y * bg!.width + X) * 4, (Y * bg!.width + X) * 4 + 3);
    };
    this.shore = shorePoints(pixelsOf(mask, w, h).data, w, h, 11, 4).filter((p) => {
      if (!bg) return true;
      const [a, b] = [paint(p.x - p.nx * 6, p.y - p.ny * 6), paint(p.x + p.nx * 14, p.y + p.ny * 14)];
      return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 70;
    });
  }

  /** The foam over the swell, on the water's own canvas (before its mask cuts it): it rides higher and further than the paper under it. */
  churn(c: CanvasRenderingContext2D, t: number, storm: number) {
    const { foam } = this;
    const [w, h] = [foam.width, foam.height];
    const STRIP = 4;
    c.save();
    c.globalAlpha = 0.9;
    for (let y = 0; y < h; y += STRIP) {
      const u = y / h;
      const s = swellAt(0, u, t + 0.35, storm);
      const dx = s.dx * 1.4 + Math.sin(t * 1.9 + y * 0.07) * (0.8 + 2.5 * u) * (0.6 + storm);
      const sy = Math.max(0, Math.min(h - STRIP, y + s.dy * 1.25));
      c.drawImage(foam, 0, sy, w, STRIP, dx, y, w, STRIP);
    }
    c.restore();
  }

  /** Puffs of foam and spray where the water breaks on the shore: each swells and fades on its own beat. */
  break(ctx: CanvasRenderingContext2D, t: number, storm: number, shift: Shift) {
    const [x0, y0] = this.box;
    const h = this.box[3] - this.box[1];
    ctx.save();
    for (const [i, p] of this.shore.entries()) {
      const u = p.y / h;
      const life = 1.6 + 1.4 * rand(i, 1);
      const beat = (t + rand(i, 2) * life * 5) / life;
      const age = beat - Math.floor(beat);
      // Not every point breaks every beat: more of them in a storm.
      if (rand(Math.floor(beat) * 31 + i, 3) > 0.45 + 0.45 * storm) continue;
      const [sx, sy] = shift(y0 + p.y);
      const size = (7 + 18 * u) * (0.7 + 0.6 * storm) * (0.5 + 0.8 * rand(i, 4));
      // Thrown up and back off the shore, toward the water.
      const out = age * size * 0.8;
      const cx = x0 + sx + p.x - p.nx * out;
      const cy = y0 + sy + p.y - p.ny * out - age * size * 0.6;
      const alpha = Math.sin(Math.PI * Math.min(1, age * 1.3)) * (0.55 + 0.3 * storm);
      if (alpha <= 0.02) continue;
      // A torn-paper puff: a ragged blob that opens up as it rises.
      ctx.globalAlpha = alpha;
      ctx.fillStyle = `rgb(${this.colour})`;
      ctx.beginPath();
      const r = size * (0.45 + 0.75 * age);
      for (let k = 0; k < 9; k++) {
        const a = (k / 9) * Math.PI * 2;
        const rr = r * (0.65 + 0.45 * rand(i * 9 + k, 5 + Math.floor(beat)));
        const [px, py] = [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.6];
        if (k) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      // Spray: a few drops flung up in arcs.
      ctx.globalAlpha = alpha * 0.8;
      for (let d = 0; d < 3; d++) {
        const vx = (rand(i * 3 + d, 6) - 0.5) * size * 2.2 - p.nx * size;
        const vy = -size * (1.2 + rand(i * 3 + d, 7));
        const [dx, dy] = [vx * age, vy * age + 1.8 * size * age * age];
        ctx.fillRect(cx + dx, cy + dy, 1.6 + u * 1.4, 1.6 + u * 1.4);
      }
    }
    ctx.restore();
  }
}

/**
 * Still water swells: the texture is read in small tiles, each from a little aside and above or below (src/play
 * living.ts swellAt), so waves roll toward the viewer and the near paper heaves; crests catch a little light.
 */
export function drawSwell(c: CanvasRenderingContext2D, tex: CanvasImageSource, w: number, h: number, t: number, storm: number) {
  const TW = 20;
  const TH = 4;
  c.globalCompositeOperation = 'source-over';
  c.globalAlpha = 1;
  for (let y = 0; y < h; y += TH) {
    const u = y / Math.max(1, h);
    for (let x = 0; x < w; x += TW) {
      const s = swellAt(x, u, t, storm);
      const sy = Math.max(0, Math.min(h - TH, y + s.dy));
      // One px wider than the tile, so neighbours read from a hair apart never leave a seam.
      c.drawImage(tex, Math.max(0, Math.min(w - TW - 1, x + s.dx)), sy, TW + 1, TH, x, y, TW + 1, TH);
    }
  }
  // The crests catch the light and the troughs darken a touch, so a smooth painted sea is seen to heave.
  c.globalCompositeOperation = 'soft-light';
  for (let y = 0; y < h; y += TH) {
    const u = y / Math.max(1, h);
    for (let x = 0; x < w; x += TW * 2) {
      const { crest } = swellAt(x, u, t, storm);
      if (Math.abs(crest) < 0.55) continue;
      c.globalAlpha = (Math.abs(crest) - 0.55) * (0.5 + 0.6 * u) * (0.6 + 0.6 * storm);
      c.fillStyle = crest > 0 ? '#ffffff' : '#000010';
      c.fillRect(x, y, TW * 2, TH);
    }
  }
  c.globalCompositeOperation = 'source-over';
  c.globalAlpha = 1;
}

/** A painted waterfall pours: ripples and light run down its ribbons, foam churns at its foot and spray flies. */
export class Fall {
  private readonly canvas: HTMLCanvasElement;
  /** Per column, the fall's lowest row (its foot), -1 where the column holds none of it. */
  private readonly foot: Int16Array;

  constructor(readonly img: HTMLImageElement, readonly box: Box) {
    const [w, h] = [box[2] - box[0], box[3] - box[1]];
    this.canvas = canvasOf(w, h);
    const a = pixelsOf(img, w, h).data;
    this.foot = new Int16Array(w).fill(-1);
    for (let x = 0; x < w; x++) for (let y = h - 1; y >= 0; y--) if (a[(y * w + x) * 4 + 3] > 128) {
      this.foot[x] = y;
      break;
    }
  }

  draw(ctx: CanvasRenderingContext2D, t: number, shift: Shift) {
    const { img, canvas } = this;
    const [w, h] = [canvas.width, canvas.height];
    const c = canvas.getContext('2d')!;
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, w, h);
    // Ripples run down the ribbons: each row is pushed aside by waves travelling down the fall (no scrolled copies,
    // which doubled the paper ribbons into ghosts).
    const STRIP = 2;
    for (let y = 0; y < h; y += STRIP) {
      const dx = 2.4 * Math.sin(y * 0.12 - t * 6.5) + 1.1 * Math.sin(y * 0.047 - t * 3.3);
      c.drawImage(img, 0, y, w, STRIP, dx, y, w, STRIP);
    }
    // Cut to the fall's own shape, so only its water moves.
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(img, 0, 0);
    c.globalCompositeOperation = 'source-over';
    // Soft bands of light running down it.
    c.globalCompositeOperation = 'source-atop';
    for (let i = 0; i < 5; i++) {
      const y = ((t * 120 + i * (h / 5)) % (h + 60)) - 30;
      const band = c.createLinearGradient(0, y - 14, 0, y + 14);
      band.addColorStop(0, 'rgba(255,255,255,0)');
      band.addColorStop(0.5, 'rgba(255,255,255,0.22)');
      band.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = band;
      c.fillRect(0, y - 14, w, 28);
    }
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    const [x0, y0] = this.box;
    const [sx, sy] = shift(this.box[3]);
    ctx.drawImage(canvas, x0 + sx, y0 + sy);
    this.churn(ctx, t, x0 + sx, y0 + sy);
  }

  /** Foam boiling at the foot of the fall, and spray thrown up from it. */
  private churn(ctx: CanvasRenderingContext2D, t: number, ox: number, oy: number) {
    const { foot } = this;
    const w = foot.length;
    ctx.save();
    ctx.fillStyle = '#f2f5fa';
    for (let x = 4; x < w - 4; x += 9) {
      const y = foot[x];
      if (y < 0) continue;
      for (let j = 0; j < 2; j++) {
        const i = x * 2 + j;
        const life = 0.9 + 0.8 * rand(i, 11);
        const beat = (t + rand(i, 12) * 4) / life;
        const age = beat - Math.floor(beat);
        const r = (5 + 7 * rand(i, 13)) * (0.5 + age);
        ctx.globalAlpha = Math.sin(Math.PI * age) * 0.7;
        ctx.beginPath();
        const [cx, cy] = [ox + x + (rand(i, 14 + Math.floor(beat)) - 0.5) * 10, oy + y - 2 - age * 14];
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          const rr = r * (0.6 + 0.5 * rand(i * 8 + k, Math.floor(beat)));
          if (k) ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.7);
          else ctx.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.7);
        }
        ctx.closePath();
        ctx.fill();
        // Spray.
        ctx.globalAlpha *= 0.9;
        for (let d = 0; d < 2; d++) {
          const vx = (rand(i * 2 + d, 15 + Math.floor(beat)) - 0.5) * 60;
          const vy = -50 - 40 * rand(i * 2 + d, 16);
          ctx.fillRect(cx + vx * age, cy + vy * age + 70 * age * age, 2, 2);
        }
      }
    }
    ctx.restore();
  }
}

/** A painted animal (a fish in the river, a gull over the sea) as a small card that swims or flies. */
export class Critter {
  constructor(readonly img: HTMLImageElement, readonly box: Box, readonly medium: 'water' | 'air', readonly facing: 1 | -1, readonly k: number) {}

  draw(ctx: CanvasRenderingContext2D, t: number, shift: Shift) {
    const { img, box, k } = this;
    const [w, h] = [box[2] - box[0], box[3] - box[1]];
    const s = swimAt(t, k, this.facing, w, this.medium);
    const [sx, sy] = shift(box[3]);
    const up = s.leap ? leapHeight(s.leap, h) : 0;
    const [cx, cy] = [box[0] + w / 2 + s.dx + sx, box[1] + h / 2 + s.dy + sy - up];
    // The water rings where it leaves and where it lands.
    if (this.medium === 'water') {
      const dir = Math.sign(s.scaleX || 1) * this.facing;
      for (const [from, x] of [[0, s.dx - dir * w * 0.25], [1.05, s.dx + dir * w * 0.25]] as const) {
        const age = (s.sinceLeap - from) / 0.8;
        if (age < 0 || age > 1) continue;
        ctx.save();
        ctx.globalAlpha = (1 - age) * 0.75;
        ctx.strokeStyle = '#eef3fa';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(box[0] + w / 2 + x + sx, box[3] - h * 0.3 + sy, w * (0.2 + 0.5 * age), h * (0.06 + 0.15 * age), 0, 0, Math.PI * 2);
        ctx.stroke();
        // A few drops thrown up.
        ctx.fillStyle = '#eef3fa';
        for (let d = 0; d < 5; d++) ctx.fillRect(box[0] + w / 2 + x + sx + (d - 2) * w * 0.08 * (1 + age), box[3] - h * 0.3 + sy - Math.sin(Math.PI * age) * h * (0.4 + 0.15 * d % 3), 2, 2);
        ctx.restore();
      }
    }
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(s.rot);
    // A bird flaps: its card squashes up and down; a fish's tail end wiggles.
    const flap = this.medium === 'air' ? 1 + 0.18 * Math.sin(t * 9 + k) : 1;
    ctx.scale(Math.abs(s.scaleX) < 0.06 ? 0.06 * Math.sign(s.scaleX || 1) : s.scaleX, flap);
    const STRIP = 4;
    for (let x = 0; x < w; x += STRIP) {
      // Painted facing right, the tail is at the left (x 0): it swings most.
      const tail = this.facing > 0 ? 1 - x / w : x / w;
      const dy = this.medium === 'water' ? Math.sin(t * 7 + k - x * 0.08) * 2.4 * tail * tail : 0;
      ctx.drawImage(img, x, 0, STRIP + 1, h, x - w / 2, -h / 2 + dy, STRIP + 1, h);
    }
    ctx.restore();
  }
}

/**
 * The painted clouds as bands, each drifting with the wind at its own speed (the top one fastest), the bands
 * below first; each band's texture repeats mirrored, so it drifts on and on with no end showing. Cut to where
 * the clouds are, with what stays put in the sky (a lamp's glow, rays) laid back over.
 */
export class Clouds {
  private readonly canvas: HTMLCanvasElement;
  private readonly bands: Array<{ tile: HTMLCanvasElement; y: number; speed: number }>;

  constructor(bands: Array<{ img: HTMLImageElement; box: Box; speed: number }>, readonly clip: HTMLImageElement, readonly keep: HTMLImageElement | undefined, readonly box: Box) {
    this.canvas = canvasOf(box[2] - box[0], box[3] - box[1]);
    this.bands = bands.map(({ img, box: b, speed }) => {
      const tile = canvasOf(2 * img.width, img.height);
      const c = tile.getContext('2d')!;
      c.drawImage(img, 0, 0);
      c.save();
      c.translate(2 * img.width, 0);
      c.scale(-1, 1);
      c.drawImage(img, 0, 0);
      c.restore();
      return { tile, y: b[1] - box[1], speed };
    });
  }

  draw(ctx: CanvasRenderingContext2D, t: number, wind: number, shift: Shift) {
    const { canvas } = this;
    const c = canvas.getContext('2d')!;
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, canvas.width, canvas.height);
    // A few px a second, more in a gale; with the wind.
    const v = 4.5 * (1 + 2 * Math.abs(wind));
    const dir = wind < 0 ? -1 : 1;
    for (const b of this.bands) {
      const span = b.tile.width;
      const o = (((dir * v * b.speed * t) % span) + span) % span;
      c.drawImage(b.tile, o - span, b.y);
      c.drawImage(b.tile, o, b.y);
    }
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(this.clip, 0, 0);
    c.globalCompositeOperation = 'source-over';
    if (this.keep) c.drawImage(this.keep, 0, 0);
    const [sx, sy] = shift(this.box[3]);
    ctx.drawImage(canvas, this.box[0] + sx, this.box[1] + sy);
  }
}
