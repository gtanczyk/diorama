// Shared, serializable reaction rules and movement triggers. No DOM, audio or model calls at play time.
import { z } from 'zod';
import { When } from '../story/schema.ts';
import { holds, type State } from '../story/engine.ts';
import type { Geometry } from './geometry.ts';

export const Burst = z.object({
  kind: z.enum(['dust', 'splash', 'snow', 'leaves', 'sparks']),
  colour: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  strength: z.number().min(0.1).max(1),
});
export type Burst = z.infer<typeof Burst>;
export const AreaRule = z.object({
  key: z.string().min(1),
  cells: z.array(z.string().regex(/^[.#]+$/)).min(1),
  step: Burst.optional(),
  enter: Burst.optional(),
  when: When,
  once: z.boolean().default(false),
  cooldown: z.number().min(0.2).max(30).default(1.5),
});
export const Reactions = z.object({
  version: z.literal(1),
  source: z.string(),
  scene: z.string(),
  areas: z.array(AreaRule).max(8),
  interactions: z.array(z.object({
    key: z.string(), thing: z.string(),
    // Exact matched story interaction, so a story edit cannot silently retarget an old effect.
    action: z.string(),
    at: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
    burst: Burst,
    cooldown: z.number().min(0.2).max(30).default(1),
  })).max(12),
});
export type Reactions = z.infer<typeof Reactions>;
export type ReactionEvent = { rule: string; trigger: 'step' | 'enter' | 'interaction'; burst: Burst; x: number; y: number; depth: number; actor: object; step?: number };
export type WalkPoint = { x: number; y: number; phase: number; foot?: number };

export function inArea(area: z.infer<typeof AreaRule>, cell: number, x: number, y: number): boolean {
  return area.cells[Math.floor(y / cell)]?.[Math.floor(x / cell)] === '#';
}

export class ReactionTriggers {
  private clock = 0;
  private used = new Set<string>();
  private cooldowns = new Map<string, number>();
  constructor(readonly rules: Reactions, readonly g: Geometry, private readonly emit: (event: ReactionEvent) => void) {}
  update(dt: number) { this.clock += dt; }
  reset() { this.cooldowns.clear(); }
  private fire(rule: string, seconds: number, once: boolean, event: Omit<ReactionEvent, 'rule'>) {
    if (this.used.has(rule) || this.clock < (this.cooldowns.get(rule) ?? -Infinity)) return;
    if (once) this.used.add(rule);
    this.cooldowns.set(rule, this.clock + seconds);
    this.emit({ rule, ...event });
  }
  /** Called for each actually travelled path segment, including the last segment before stopping. */
  move(actor: object, from: WalkPoint, to: WalkPoint, state: State) {
    if (from.x === to.x && from.y === to.y) return;
    const point = (t: number) => ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    // Sample crossings more finely than the walk grid: even a small patch crossed in one frame fires.
    const n = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / (this.g.cell / 2)));
    for (const a of this.rules.areas) {
      if (!holds(state, a.when)) continue;
      if (a.enter) {
        let inside = inArea(a, this.g.cell, from.x, from.y);
        for (let i = 1; i <= n; i++) {
          const p = point(i / n), next = inArea(a, this.g.cell, p.x, p.y);
          if (next && !inside) this.fire(a.key, a.cooldown, a.once, { trigger: 'enter', burst: a.enter, ...p, depth: p.y, actor });
          inside = next;
        }
      }
      if (a.step && to.phase > from.phase) {
        for (let step = Math.floor(from.phase * 2) + 1; step <= Math.floor(to.phase * 2); step++) {
          const t = (step / 2 - from.phase) / (to.phase - from.phase), p = point(t);
          if (inArea(a, this.g.cell, p.x, p.y)) this.emit({ rule: a.key, trigger: 'step', burst: a.step, step, ...p,
            y: (from.foot ?? from.y) + ((to.foot ?? to.y) - (from.foot ?? from.y)) * t, depth: p.y, actor });
        }
      }
    }
  }
  interact(action: string, actor: object, depth: (key: string) => number) {
    for (const r of this.rules.interactions) {
      if (r.action !== action) continue;
      const thing = this.g.things.find((t) => t.key === r.thing);
      if (!thing) continue;
      const [x0, y0, x1, y1] = thing.box;
      this.fire(r.key, r.cooldown, false, { trigger: 'interaction', burst: r.burst,
        x: x0 + r.at[0] * (x1 - x0), y: y0 + r.at[1] * (y1 - y0), depth: depth(r.thing) + 8, actor });
    }
  }
}
