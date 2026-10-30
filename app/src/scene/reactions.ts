// One vision-language plan per place. Bind proposals to reachable walk cells and exact story actions.
import { z } from 'zod';
import { Burst, Reactions } from '../play/reactions.ts';
import { When, type Story } from '../story/schema.ts';
import type { Geometry } from '../play/geometry.ts';
import type { Layout } from './layout.ts';
import type { Place, World } from '../world/schema.ts';
import { askSparkJson } from '../meta/spark.ts';
import { inputHash, type Memo } from '../meta/memo.ts';
import { gridOf } from './verify.ts';
import { reach } from './walk.ts';

const XY = z.tuple([z.number(), z.number()]);
export const ReactionPlan = z.object({
  scene: z.string().min(1),
  areas: z.array(z.object({
    key: z.string().min(1), floor: z.string(),
    polygon: z.array(XY).min(3).max(12).optional(),
    step: Burst.optional(), enter: Burst.optional(), when: When,
    once: z.boolean().default(false), cooldown: z.number().min(0.2).max(30).default(1.5),
  })).max(8),
  interactions: z.array(z.object({
    key: z.string(), interaction: z.number().int().nonnegative(),
    at: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
    burst: Burst, cooldown: z.number().min(0.2).max(30).default(1),
  })).max(12),
});
export type ReactionPlan = z.infer<typeof ReactionPlan>;
export type ReactionInput = { world: World; place: Place; layout: Layout; geometry: Geometry; story: Story | null; weather?: unknown; hint?: string; painting: Buffer };
export function reactionSource(i: ReactionInput): string {
  return inputHash('reactions-planner-2', JSON.stringify({ style: i.world.style, place: i.place, layout: i.layout, geometry: i.geometry, story: i.story, weather: i.weather, hint: i.hint }), i.painting);
}
function contains(p: number[][], x: number, y: number) {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [a, b] = p[i], [c, d] = p[j];
    if ((b > y) !== (d > y) && x < (c - a) * (y - b) / (d - b) + a) inside = !inside;
  }
  return inside;
}
export function bindReactions(plan: ReactionPlan, input: ReactionInput): Reactions {
  const { geometry: g, layout, story, place } = input;
  const grid = gridOf(g);
  const cellOf = (x: number, y: number) => grid.at(Math.floor(x / g.cell), Math.floor(y / g.cell));
  const reachable = reach(grid, cellOf(...g.start));
  const seen = new Set<string>();
  const key = (k: string) => { if (seen.has(k)) throw new Error(`duplicate reaction key ${k}`); seen.add(k); };
  const facts = new Set(story?.interactions.flatMap((it) => it.do.flatMap((e) => 'set' in e ? [e.set] : [])) ?? []);
  for (const d of story?.dialogues ?? []) for (const l of d.lines) for (const c of l.choices) for (const e of c.do) if ('set' in e) facts.add(e.set);
  const areas = plan.areas.map((a) => {
    key(a.key);
    if (!a.step && !a.enter) throw new Error(`${a.key}: needs step or enter`);
    for (const f of a.when) {
      const fact = f.replace(/^!/, '');
      if (!(fact.startsWith('has:') ? story?.items.some((i) => i.key === fact.slice(4)) : fact.startsWith('at:') ? input.world.places.some((p) => p.key === fact.slice(3)) : facts.has(fact))) throw new Error(`${a.key}: unknown condition ${f}`);
    }
    const floor = layout.floors.findIndex((f) => f.key === a.floor);
    if (floor < 0) throw new Error(`${a.key}: unknown floor ${a.floor}`);
    if (a.polygon?.some(([x, y]) => x < 0 || y < 0 || x > g.frame.width || y > g.frame.height)) throw new Error(`${a.key}: polygon outside painting`);
    const cells = g.walk.map((row, r) => [...row].map((ch, c) => ch === '#' && reachable[grid.at(c, r)] && g.zone?.[r]?.[c] === String(floor) && (!a.polygon || contains(a.polygon, (c + .5) * g.cell, (r + .5) * g.cell)) ? '#' : '.').join(''));
    if (!cells.some((row) => row.includes('#'))) throw new Error(`${a.key}: no reachable cells on ${a.floor}`);
    const { floor: _, polygon: __, ...rule } = a;
    return { ...rule, cells };
  });
  // Two step recipes in one cell double every footstep; local patches must partition the floor.
  const steps = new Set<number>();
  for (const a of areas.filter((a) => a.step)) a.cells.forEach((row, r) => [...row].forEach((v, c) => {
    if (v !== '#') return;
    const i = grid.at(c, r);
    if (steps.has(i)) throw new Error('step areas overlap: partition the polygons or use one recipe per floor');
    steps.add(i);
  }));
  const assigned = new Set<number>();
  const interactions = plan.interactions.map((r) => {
    key(r.key);
    if (assigned.has(r.interaction)) throw new Error(`${r.key}: duplicate interaction recipe`);
    assigned.add(r.interaction);
    const it = story?.interactions[r.interaction];
    if (!it || it.place !== place.key || !['use', 'take'].includes(it.verb)) throw new Error(`${r.key}: interaction must be a use or take in this place`);
    const thing = g.things.find((t) => t.key === it.thing);
    if (!thing || !reachable[cellOf(...thing.stand)]) throw new Error(`${r.key}: no reachable target ${it.thing}`);
    const { interaction: _, ...rule } = r;
    return { ...rule, thing: it.thing, action: JSON.stringify(it) };
  });
  return Reactions.parse({ version: 1, source: reactionSource(input), scene: plan.scene, areas, interactions });
}

export async function planReactions(memo: Memo, input: ReactionInput): Promise<{ plan: ReactionPlan; reactions: Reactions }> {
  const { world, place, layout, geometry: g, story } = input;
  const actions = story?.interactions.flatMap((it, index) => it.place === place.key && ['use', 'take'].includes(it.verb) ? [{ index, ...it }] : []) ?? [];
  const prompt = `Plan subtle physical reactions for this painted point-and-click scene. Return JSON only.
Style: ${world.style}
Place: ${JSON.stringify(place)}
Frame pixels: ${g.frame.width} x ${g.frame.height}. Floors, in zone order: ${JSON.stringify(layout.floors)}
Actual objects and their boxes/stand points: ${JSON.stringify(g.things)}
Weather: ${JSON.stringify(input.weather ?? {})}
Available story interactions, with global indexes: ${JSON.stringify(actions)}
Author's preference: ${input.hint ?? 'Choose restrained, natural effects automatically.'}

Return {scene: short explanation of material, wetness and style choices, areas: [], interactions: []}.
An area: {key, floor: exact floor key, polygon?: [[pixelX,pixelY],...], step?: burst, enter?: burst, when: [], once: false, cooldown: 1.5}.
Omit polygon for the whole floor; use it only for a clearly visible local patch (leaves, snow, dust, puddle) and keep it on that floor. The compiler clips it to reachable floor cells. No overlapping step areas: use a single recipe per floor or non-overlapping polygons. Enter means crossing into an area, not spawning there; use it only where entry really stirs something, not as a second effect on every ordinary floor. Conditions use story facts (!flag, has:item); normally [].
Look specifically for localized loose material on reachable ground, such as scattered straw near a hay cart, leaves beneath a tree, or a small puddle. When present, an enter-only polygon can add one small burst on crossing its boundary, with a cooldown. It may overlap a general step area. Do not place it on the solid cart/tree itself. Straw/chaff can use pale-gold leaves or dust. When there is no convincing patch, omit it.
A burst: {kind: dust|splash|snow|leaves|sparks, colour: #rrggbb, strength: 0.1..1}. Prefer 0.25..0.5. Dry loose soil/sand/dust: dust. Wet floors/puddles: splash. Lying snow: snow. Visible loose leaves: leaves. Sparks only for actual fire/magic/metal impact supported by the story. Clean wood, clean stone, indoor tiles: no effect. Rain in the air alone does not prove a floor is wet. Do not invent dusty surfaces to fill the lists; empty lists are valid.
An interaction: {key, interaction: global index above, at: [0..1,0..1] within that object's box, burst, cooldown: 1}.
Choose only physical use/take actions: dust dislodged from a dusty object, droplets shaken off a wet object, leaves stirred from vegetation, a supported magical response. Never attach a reaction to a refusal, looking, conversation, or a failed prerequisite. Do not add generic success glitter to clean items. Match the actual action outcome and object material. No more than 8 areas and 12 interactions.`;
  let problem = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const plan = ReactionPlan.parse(await askSparkJson(memo, { schema: ReactionPlan, label: `reactions:${place.key}`, images: [input.painting], prompt: prompt + problem }));
      return { plan, reactions: bindReactions(plan, input) };
    } catch (e) {
      if (attempt === 2) throw e;
      problem = `\nCorrect the previous plan: ${e instanceof Error ? e.message : String(e)}. Use only the provided floors, objects and actions.`;
    }
  }
  throw new Error('reaction planning failed');
}
