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

  constructor(private readonly glows: Glow[], private readonly H: number) {
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
      halo(ctx, x, y, r * (0.85 + 0.3 * level), c, a * (0.4 + level));
    });
    ctx.restore();
  }
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
