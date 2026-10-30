import { ReactionTriggers, type ReactionEvent, type Reactions } from '../src/play/reactions.ts';
import { personPx, type Geometry } from '../src/play/geometry.ts';
import { hashSeed, seeded } from '../src/play/weather.ts';

type Particle = { x: number; y: number; depth: number; vx: number; vy: number; size: number; life: number; age: number; angle: number; spin: number; kind: ReactionEvent['burst']['kind']; colour: string; alpha: number };
type Rect = [number, number, number, number];
const LIMIT = 96;

/** Small pooled-in-count particles, drawn in the scene's depth order, below UI and weather. */
export class ReactionFx {
  readonly triggers: ReactionTriggers;
  readonly particles: Particle[] = [];
  readonly counts = { step: 0, enter: 0, interaction: 0 };
  private rand: () => number;
  private textures = new Map<string, HTMLCanvasElement>();
  constructor(rules: Reactions, private readonly g: Geometry, key: string, private readonly reduced = false) {
    this.rand = seeded(hashSeed(`reactions:${key}`));
    this.triggers = new ReactionTriggers(rules, g, (e) => this.spawn(e));
  }
  reset() { this.particles.length = 0; this.triggers.reset(); }
  private spawn(e: ReactionEvent) {
    this.counts[e.trigger]++;
    if (this.reduced) return;
    const body = e.actor as { yaw?: number; phase?: number; figure?: { height?: number } };
    const h = personPx(this.g, e.depth) * (e.trigger === 'interaction' ? 1 : (body.figure?.height ?? 1.62) / 1.62);
    const scale = e.trigger === 'step' ? 0.85 : 1.15;
    const strength = e.burst.strength;
    const n = Math.ceil((e.burst.kind === 'dust' ? 5 : 7) * (0.5 + strength) * scale);
    const foot = e.trigger === 'step' ? Math.cos(body.yaw ?? 0) * h * 0.035 * ((e.step ?? 0) % 2 ? -1 : 1) : 0;
    for (let i = 0; i < n; i++) {
      if (this.particles.length >= LIMIT) this.particles.shift();
      const dust = e.burst.kind === 'dust';
      this.particles.push({ x: e.x + foot + (this.rand() - .5) * h * .025, y: e.y, depth: e.depth,
        vx: (this.rand() - .5) * h * (dust ? .22 : .28), vy: -h * (dust ? .045 + this.rand() * .045 : .12 + this.rand() * .17),
        size: h * (dust ? .036 + this.rand() * .0225 : .008 + this.rand() * .01) * scale,
        life: dust ? .65 + this.rand() * .3 : .45 + this.rand() * .3, age: 0,
        angle: this.rand() * Math.PI, spin: (this.rand() - .5) * 7,
        kind: e.burst.kind, colour: e.burst.colour, alpha: (dust ? .48 + .2 * strength : .65 + .25 * strength) });
    }
  }
  update(dt: number) {
    this.triggers.update(dt);
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.age += dt;
      if (p.age >= p.life) { this.particles.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.angle += p.spin * dt;
      if (p.kind !== 'dust' && p.kind !== 'sparks') p.vy += personPx(this.g, p.depth) * .5 * dt;
    }
    this.particles.sort((a, b) => a.depth - b.depth);
  }
  private blob(colour: string) {
    let c = this.textures.get(colour);
    if (c) return c;
    c = Object.assign(document.createElement('canvas'), { width: 48, height: 48 });
    const ctx = c.getContext('2d')!, grad = ctx.createRadialGradient(24, 24, 1, 24, 24, 24);
    // A readable body with a soft edge: a tiny Gaussian vanished against detailed painted floors.
    const shade = '#' + colour.slice(1).match(/../g)!.map((v) => Math.round(parseInt(v, 16) * .74).toString(16).padStart(2, '0')).join('');
    grad.addColorStop(0, colour); grad.addColorStop(.4, colour);
    grad.addColorStop(.7, shade + 'bb'); grad.addColorStop(1, shade + '00');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, 48, 48);
    this.textures.set(colour, c); return c;
  }
  draw(ctx: CanvasRenderingContext2D, lo: number, hi: number, shift: (y: number) => [number, number], occlude: (r: Rect, depth: number) => void) {
    for (const p of this.particles) {
      if (p.depth < lo || p.depth >= hi) continue;
      const t = p.age / p.life, [sx, sy] = shift(p.depth), x = p.x + sx, y = p.y + sy;
      const r = p.size * (p.kind === 'dust' ? .6 + t : 1);
      ctx.save(); ctx.translate(x, y); ctx.rotate(p.angle);
      ctx.globalAlpha = p.alpha * Math.min(1, t * 16) * (1 - t * t);
      ctx.fillStyle = p.colour;
      if (p.kind === 'dust') ctx.drawImage(this.blob(p.colour), -r, -r * .6, 2 * r, 1.2 * r);
      else if (p.kind === 'leaves') { ctx.beginPath(); ctx.ellipse(0, 0, r, r * .4, 0, 0, Math.PI * 2); ctx.fill(); }
      else { ctx.beginPath(); ctx.ellipse(0, 0, r * .6, p.kind === 'splash' ? r : r * .6, 0, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
      occlude([x - r * 1.3, y - r * 1.3, x + r * 1.3, y + r * 1.3], p.depth);
    }
  }
}
