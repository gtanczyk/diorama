// The weather of a place (weather.json): rain or snow over the whole frame, each drop ending on the floor row
// as far away as it is, some of them ringing on water and puddles or splashing on the floor, and drops that
// gather on the edges Spark named (eaves, a gutter) and fall to the ground under them. Seeded, so a capture
// run rains the same every time.
import { personPx, type Geometry } from '../src/play/geometry.ts';
import { hashSeed, seeded, type Weather } from '../src/play/weather.ts';
import type { Pool } from './glows.ts';

type Shift = (y: number) => [number, number];
type Mark = { x: number; y: number; t: number; size: number; ring: boolean };
type Bank = { x: number; y: number; w: number; h: number; v: number; a: number };
type Drip = { x: number; y: number; to: number; t: number; wait: number; falling: boolean };

/** One landing in this many leaves a mark (a ring or a splash); all of them would boil the floor. */
const MARK_EVERY = 9;
const RING_LIFE = 0.9;
const SPLASH_LIFE = 0.22;
/** A drop gathers on its edge this long before it lets go. */
const GATHER = 0.4;
const GRAVITY_M = 9.81;

export class WeatherFx {
  private readonly rand: () => number;
  private readonly W: number;
  private readonly H: number;
  /** Falling rain or snow: x, y, depth (0 far .. 1 near), and the row each one ends on. */
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly end: Float32Array;
  private readonly marks: Mark[] = [];
  private readonly drips: Drip[] = [];
  /** Some pixels of the ripple mask, to ring at between landings. */
  private readonly ringAt: Uint32Array;
  private ringDebt = 0;
  /** Mist: wide soft banks drifting across the frame with the wind, one blurred blob drawn stretched. */
  private readonly banks: Bank[] = [];
  private blob?: HTMLCanvasElement;
  private time = 0;

  constructor(readonly w: Weather, private readonly g: Geometry, private readonly ripples?: Uint8Array, key = '') {
    this.rand = seeded(hashSeed(key || 'weather'));
    this.W = g.frame.width;
    this.H = g.frame.height;
    const n = w.fall === 'rain' ? Math.round(140 + 560 * w.strength) : w.fall === 'snow' ? Math.round(90 + 320 * w.strength) : 0;
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.end = new Float32Array(n);
    for (let i = 0; i < n; i++) this.spawn(i, this.rand() * this.H);
    const at: number[] = [];
    if (ripples) for (let i = 0; i < ripples.length; i += 7) if (ripples[i]) at.push(i);
    this.ringAt = Uint32Array.from(at);
    const fog = w.fog ?? 0;
    if (fog > 0) {
      const hor = Math.max(0, Math.min(this.H * 0.7, g.scale.horizonY));
      const dir = w.wind < 0 ? -1 : 1;
      for (let k = 0, n = 5 + Math.round(7 * fog); k < n; k++) {
        const bw = this.W * (0.35 + 0.4 * this.rand());
        const near = this.rand();
        // From a little above the horizon down to the near floor; near banks are bigger, faster and thinner.
        this.banks.push({ x: this.rand() * (this.W + bw) - bw, y: hor - this.H * 0.12 + near * (this.H - hor) * 0.95, w: bw * (0.8 + 0.5 * near), h: bw * (0.16 + 0.08 * this.rand()), v: dir * (10 + 16 * near + 30 * Math.abs(w.wind)), a: fog * (0.35 + 0.25 * this.rand()) * (1 - 0.35 * near) });
      }
    }
    for (const d of w.drips) d.from.forEach(([x, y], k) => this.drips.push({ x, y, to: d.to[k], t: 0, wait: this.rand() * 2.5, falling: false }));
  }

  private spawn(i: number, y: number) {
    const z = this.rand() ** 0.7;
    this.pz[i] = z;
    // Far drops end high on the floor, near ones at the bottom of the frame.
    const hor = Math.max(0, this.g.scale.horizonY);
    this.end[i] = hor + (this.H - hor) * (0.15 + 0.85 * z) + this.rand() * 30;
    this.py[i] = y - this.H * 0.15;
    // Starting further upwind, so a slanted fall still covers the frame.
    this.px[i] = this.rand() * (this.W + Math.abs(this.w.wind) * this.H) - Math.max(0, this.w.wind) * this.H;
  }

  private walkable(x: number, y: number): boolean {
    const row = this.g.walk[Math.floor(y / this.g.cell)];
    return !!row && row[Math.floor(x / this.g.cell)] === '#';
  }

  private wetAt(x: number, y: number): boolean {
    if (!this.ripples || x < 0 || y < 0 || x >= this.W || y >= this.H) return false;
    return !!this.ripples[Math.floor(y) * this.W + Math.floor(x)];
  }

  /** A ring on water or a puddle, a splash on the floor, nothing elsewhere (a roof, the sky). */
  private land(x: number, y: number) {
    // Water past the horizon line still rings, small (the scale's horizon is only where people shrink to nothing).
    const p = Math.max(24, personPx(this.g, y));
    if (this.wetAt(x, y)) this.marks.push({ x, y, t: 0, size: p * 0.09, ring: true });
    else if (y > this.g.scale.horizonY && this.walkable(x, y)) this.marks.push({ x, y, t: 0, size: p * 0.05, ring: false });
  }

  update(dt: number) {
    this.time += dt;
    for (const b of this.banks) {
      b.x += b.v * dt;
      if (b.v > 0 && b.x > this.W) b.x = -b.w;
      if (b.v < 0 && b.x + b.w < 0) b.x = this.W;
    }
    const { w } = this;
    const rain = w.fall === 'rain';
    for (let i = 0; i < this.px.length; i++) {
      const z = this.pz[i];
      if (rain) {
        const v = (650 + 1150 * z) * dt;
        this.py[i] += v;
        this.px[i] += w.wind * v;
      } else {
        const v = (28 + 80 * z) * dt;
        this.py[i] += v;
        this.px[i] += w.wind * v + Math.sin(this.time * (0.8 + z) + i) * 14 * z * dt;
      }
      if (this.py[i] < this.end[i]) continue;
      if (rain && i % MARK_EVERY === 0) this.land(this.px[i], this.end[i]);
      this.spawn(i, -this.rand() * 40);
    }
    // Between landings, puddles and water still ring now and then, so a small puddle is never still for long.
    if (rain && this.ringAt.length) {
      this.ringDebt += dt * (6 + 30 * w.strength) * Math.min(1, this.ringAt.length / 4000);
      while (this.ringDebt >= 1) {
        this.ringDebt--;
        const i = this.ringAt[Math.floor(this.rand() * this.ringAt.length)];
        this.land(i % this.W, Math.floor(i / this.W));
      }
    }
    for (const m of this.marks) m.t += dt;
    for (let k = this.marks.length - 1; k >= 0; k--) if (this.marks[k].t > (this.marks[k].ring ? RING_LIFE : SPLASH_LIFE)) this.marks.splice(k, 1);
    // Heavier rain, faster drips; a dry place drips slowly (a cave, a pipe).
    const pace = rain ? 0.6 + w.strength : 0.5;
    for (const d of this.drips) {
      d.t += dt;
      if (!d.falling) {
        if (d.t >= d.wait + GATHER) [d.falling, d.t] = [true, 0];
        continue;
      }
      if (this.fallen(d) < d.to) continue;
      this.land(d.x, d.to);
      [d.falling, d.t, d.wait] = [false, 0, (0.5 + this.rand() * 2.2) / pace];
    }
  }

  /** Where a falling drip is now: under gravity, at the scale of the place where it lands. */
  private fallen(d: Drip): number {
    const g = (GRAVITY_M * personPx(this.g, d.to)) / 1.62;
    return d.y + 0.5 * g * d.t * d.t;
  }

  /** Rings and splashes on the ground, each sliding with the floor row it lies on. */
  drawGround(ctx: CanvasRenderingContext2D, shift: Shift) {
    if (!this.marks.length) return;
    ctx.save();
    ctx.lineWidth = 1;
    for (const m of this.marks) {
      const [sx, sy] = shift(m.y);
      const x = m.x + sx;
      const y = m.y + sy;
      if (m.ring) {
        const p = m.t / RING_LIFE;
        const r = Math.max(1, m.size * (0.25 + p));
        ctx.strokeStyle = `rgba(215,228,240,${0.55 * (1 - p)})`;
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * 0.38, 0, 0, Math.PI * 2);
        ctx.stroke();
        if (r > 4) {
          ctx.strokeStyle = `rgba(215,228,240,${0.3 * (1 - p)})`;
          ctx.beginPath();
          ctx.ellipse(x, y, r * 0.55, r * 0.21, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
      } else {
        // A small crown: a few droplets thrown up and out, falling back.
        const p = m.t / SPLASH_LIFE;
        const s = Math.max(2, m.size);
        ctx.fillStyle = `rgba(220,232,245,${0.7 * (1 - p)})`;
        for (let k = -2; k <= 2; k++) {
          const dx = k * s * 0.35 * (0.4 + p);
          const dy = -s * (0.9 - Math.abs(k) * 0.2) * Math.sin(Math.PI * p);
          const r = Math.max(0.6, s * 0.09);
          ctx.fillRect(x + dx - r / 2, y + dy - r / 2, r, r);
        }
      }
    }
    ctx.restore();
  }

  /** Drops gathering on their edges and falling, each sliding with the floor row it falls to. */
  drawDrips(ctx: CanvasRenderingContext2D, shift: Shift) {
    if (!this.drips.length) return;
    ctx.save();
    for (const d of this.drips) {
      const [sx, sy] = shift(d.to);
      const s = Math.max(1.2, personPx(this.g, d.to) * 0.012);
      if (!d.falling) {
        if (d.t < d.wait) continue;
        // Swelling on the edge before it lets go.
        const grow = (d.t - d.wait) / GATHER;
        ctx.fillStyle = `rgba(225,235,245,${0.35 + 0.45 * grow})`;
        ctx.beginPath();
        ctx.ellipse(d.x + sx, d.y + sy + s * grow * 0.6, s * (0.5 + 0.5 * grow), s * (0.6 + 0.8 * grow), 0, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      const y = Math.min(d.to, this.fallen(d));
      const v = (GRAVITY_M * personPx(this.g, d.to)) / 1.62 * d.t;
      const len = Math.min(s * 8, Math.max(s * 1.5, v * 0.025));
      ctx.strokeStyle = 'rgba(225,235,245,0.75)';
      ctx.lineWidth = s;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(d.x + sx, y + sy - len);
      ctx.lineTo(d.x + sx, y + sy);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** The rain or snow itself, over everything: three depths, far ones thin, faint and short. Drops falling through
   * a light's pool (a lamp, a lighthouse beam: GlowFx.pools) catch it and shine in its colour. */
  drawAir(ctx: CanvasRenderingContext2D, lights: Pool[] = []) {
    this.drawFog(ctx);
    const n = this.px.length;
    if (!n) return;
    ctx.save();
    const { wind, strength } = this.w;
    if (this.w.fall === 'rain') {
      ctx.lineCap = 'round';
      const norm = 1 / Math.hypot(wind, 1);
      for (const [lo, hi] of [[0, 0.4], [0.4, 0.75], [0.75, 1.01]]) {
        const z = (lo + hi) / 2;
        ctx.strokeStyle = `rgba(200,215,235,${(0.16 + 0.3 * z) * (0.65 + 0.35 * strength)})`;
        ctx.lineWidth = 0.7 + 1.1 * z;
        const len = (10 + 38 * z) * (this.H / 900);
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          if (this.pz[i] < lo || this.pz[i] >= hi) continue;
          const x = this.px[i];
          const y = this.py[i];
          ctx.moveTo(x - wind * len * norm, y - len * norm);
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      if (lights.length) this.drawLitRain(ctx, lights, norm);
    } else {
      ctx.fillStyle = 'rgba(245,248,252,0.85)';
      for (let i = 0; i < n; i++) {
        const z = this.pz[i];
        const r = 0.8 + 2.4 * z;
        ctx.globalAlpha = 0.45 + 0.5 * z;
        ctx.beginPath();
        ctx.arc(this.px[i], this.py[i], r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  private drawLitRain(ctx: CanvasRenderingContext2D, lights: Pool[], norm: number) {
    const { wind } = this.w;
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.px.length; i++) {
      const [x, y, z] = [this.px[i], this.py[i], this.pz[i]];
      let [best, c] = [0, ''];
      for (const l of lights) {
        const d = Math.hypot(x - l.x, y - l.y);
        if (d >= l.r) continue;
        const a = l.a * (1 - d / l.r) ** 1.5;
        if (a > best) [best, c] = [a, l.c];
      }
      if (best < 0.04) continue;
      const len = (10 + 38 * z) * (this.H / 900);
      ctx.strokeStyle = `rgba(${c},${Math.min(1, best * (0.6 + 0.6 * z))})`;
      ctx.lineWidth = 1 + 1.4 * z;
      ctx.beginPath();
      ctx.moveTo(x - wind * len * norm, y - len * norm);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Mist over the place: each bank a soft white blob, breathing a little as it drifts. */
  private drawFog(ctx: CanvasRenderingContext2D) {
    if (!this.banks.length) return;
    if (!this.blob) {
      this.blob = Object.assign(document.createElement('canvas'), { width: 128, height: 128 });
      const c = this.blob.getContext('2d')!;
      const grad = c.createRadialGradient(64, 64, 0, 64, 64, 64);
      grad.addColorStop(0, 'rgba(228,232,238,1)');
      grad.addColorStop(0.55, 'rgba(228,232,238,0.45)');
      grad.addColorStop(1, 'rgba(228,232,238,0)');
      c.fillStyle = grad;
      c.fillRect(0, 0, 128, 128);
    }
    ctx.save();
    for (const [k, b] of this.banks.entries()) {
      ctx.globalAlpha = b.a * (0.8 + 0.2 * Math.sin(this.time * 0.3 + k * 1.7));
      ctx.drawImage(this.blob, b.x, b.y - b.h / 2, b.w, b.h);
    }
    ctx.restore();
  }
}
