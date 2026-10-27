// sound.json: what a world sounds like. Spark plans it from the world, each place's brief and floors,
// and the story; code turns each line into a stable sound id, so a re-plan only regenerates what changed.
import { z } from 'zod';
import type { Memo } from '../meta/memo.ts';
import { askSparkJson } from '../meta/spark.ts';
import type { Brief } from '../scene/brief.ts';
import type { Layout } from '../scene/layout.ts';
import type { Story } from '../story/schema.ts';
import { Fact } from '../story/schema.ts';
import type { World } from '../world/schema.ts';

const Prompt = z.string().min(8);
/** 1 quiet, 2 normal, 3 loud: how it sits in the mix next to the place bed. */
const Level = z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2);

export const SoundPlan = z.object({
  /** Hash of what the plan was made from (world, story, briefs, floors); when that changes the plan is made again. */
  from: z.string().optional(),
  /** A music bed for the whole world, looped under everything. */
  music: z.object({ prompt: Prompt }),
  places: z.record(z.string(), z.object({
    /** The constant air of the place: wind, sea, room tone. */
    bed: Prompt,
    /** A sound that comes from one thing and pans and fades with where the hero stands. */
    loops: z.array(z.object({ thing: z.string(), prompt: Prompt, level: Level, when: z.array(Fact).default([]) })).max(6).default([]),
    /** Floor key (layout.json) to the surface the hero's feet hit there. */
    floors: z.record(z.string(), z.string()),
  })),
  /** Surface name to what a few footsteps on it sound like. */
  steps: z.record(z.string(), Prompt),
  /** Short one-shots: picking up an item, an exit, using a thing, the ending. */
  shots: z.array(z.object({ on: z.string(), prompt: Prompt, seconds: z.number().min(0.5).max(5).default(1.5), level: Level })).max(16).default([]),
});
export type SoundPlan = z.infer<typeof SoundPlan>;

/** What fires a one-shot; the runtime matches these. */
export const SHOT_TRIGGERS = ['take', 'exit:<thing key>', 'use:<thing key>', 'talk', 'ending', 'click'] as const;

export const slugOf = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x';

/** The id a planned sound is stored and played under. Ids depend on what the sound is for, never on its prompt. */
export const soundIds = {
  music: () => 'music',
  bed: (place: string) => `${place}-bed`,
  loop: (place: string, thing: string) => `${place}-${thing}-loop`,
  step: (surface: string) => `step-${slugOf(surface)}`,
  shot: (on: string) => `shot-${slugOf(on)}`,
};

export type PlaceSources = { brief?: Brief; layout?: Layout };

export function planIssues(plan: SoundPlan, world: World, sources: Record<string, PlaceSources>): string[] {
  const issues: string[] = [];
  for (const place of world.places) {
    const p = plan.places[place.key];
    if (!p) {
      issues.push(`no sounds for place ${place.key}`);
      continue;
    }
    const things = new Set(place.things.map((t) => t.key));
    for (const loop of p.loops) if (!things.has(loop.thing)) issues.push(`${place.key}: loop on "${loop.thing}", which is not one of its things`);
    for (const floor of sources[place.key]?.layout?.floors ?? []) {
      const surface = p.floors[floor.key];
      if (!surface) issues.push(`${place.key}: floor ${floor.key} has no surface`);
      else if (!plan.steps[surface]) issues.push(`${place.key}: surface "${surface}" of ${floor.key} has no footsteps in steps`);
    }
    // Every thing the brief animates should be heard too, unless it is silent by nature (a light, cloth).
    // A moving floor (water under a quay) has nothing to pan to; the bed carries it.
    for (const alive of sources[place.key]?.brief?.alive ?? []) {
      if (things.has(alive.key) && ['water', 'fire', 'smoke'].includes(alive.as) && !p.loops.some((l) => l.thing === alive.key)) issues.push(`${place.key}: ${alive.key} is ${alive.as} but makes no sound`);
    }
  }
  return issues;
}

/** Drops loops on keys that are not things of their place (a floor, say): nothing in the page to pan them to. */
export function withoutStrayLoops(plan: SoundPlan, world: World): SoundPlan {
  const places = Object.fromEntries(Object.entries(plan.places).map(([key, p]) => {
    const things = new Set(world.places.find((w) => w.key === key)?.things.map((t) => t.key) ?? []);
    return [key, { ...p, loops: p.loops.filter((l) => things.has(l.thing)) }];
  }));
  return { ...plan, places };
}

function storyLines(story: Story | null): string[] {
  if (!story) return [];
  const lines = story.interactions.filter((i) => i.verb !== 'look').map((i) => `- ${i.place}: ${i.verb} ${i.thing}${i.with ? ` with ${i.with}` : ''} -> "${i.say}"`);
  for (const c of story.changes) lines.push(`- ${c.place}: once ${c.when.join(' and ')}, ${c.thing} becomes "${c.looks}"`);
  return lines;
}

export async function writeSoundPlan(memo: Memo, world: World, story: Story | null, sources: Record<string, PlaceSources>): Promise<SoundPlan> {
  const places = world.places.map((place) => {
    const brief = sources[place.key]?.brief;
    const floors = sources[place.key]?.layout?.floors ?? [];
    return `## ${place.key}
Shows: ${place.shows}
Mood: ${place.mood}
Things: ${place.things.map((t) => `${t.key} (${t.role}: ${brief?.looks[t.key] ?? t.looks})`).join('; ')}
Moving things: ${brief?.alive.map((a) => `${a.key} is ${a.as}`).join(', ') || 'none'}
Floors: ${floors.map((f) => `${f.key} (${brief?.looks[f.key] ?? f.is})`).join('; ') || 'none'}
Exits: ${place.exits.map((e) => `${e.via} to ${e.to}`).join(', ') || 'none'}`;
  }).join('\n\n');
  const prompt = `You are the sound designer of a 2D painted point-and-click adventure. Each sound you describe is generated by a text-to-sound model, so every prompt names concrete sources, materials, distance and character, never music theory or feelings alone.

Game: ${world.title}. ${world.pitch}
Look: ${world.style}

${places}

What the hero does in the story:
${storyLines(story).join('\n') || '- (no story yet)'}

Plan:
- music: one instrumental music bed for the whole game, under everything: instruments, tempo, mood. No vocals.
- per place: "bed", the quiet ambience of the place (water, distant life, birds far off, a room's warm hum) that loops for minutes without a single event standing out. Not wind, rustling leaves, "air tone" or breathing: those come out as hiss that tires the ear under the whole game. No footsteps, no voices, no music in it.
- per place: "loops", up to 4 sounds that come from one of its things (thing key from its Things) and loop: water, fire, machines, animals. Only for things that would really sound; not trees, bushes or grass in the wind, and not someone breathing. "when" lists story facts that must hold for it to play, e.g. ["lamp-lit"] for a fire that starts in the story (use [] when always). level 1 quiet, 2 normal, 3 loud.
- per place: "floors", each floor key to a surface name such as "wood", "wet-wood", "stone", "gravel", "grass", "sand", "metal", "carpet". Reuse surface names across places.
- "steps": each surface name used to a prompt for a few separate footsteps of one person walking on it, e.g. "slow footsteps of boots on wet wooden planks, 6 separate steps, dry close recording".
- "shots": short one-shot effects. "on" is one of: ${SHOT_TRIGGERS.join(', ')}. Give one for "take" (picking up an item), "click" (a soft UI click), "talk" (a short sound as a conversation starts), "ending", one "exit:<thing>" per exit thing, and "use:<thing>" for things the story changes when used. "seconds" 0.5 to 4.

Reply with JSON only:
{"music": {"prompt": "..."}, "places": {"<place key>": {"bed": "...", "loops": [{"thing": "<thing key>", "prompt": "...", "level": 2, "when": []}], "floors": {"<floor key>": "<surface>"}}}, "steps": {"<surface>": "..."}, "shots": [{"on": "take", "prompt": "...", "seconds": 1.5, "level": 2}]}`;
  let feedback = '';
  for (let attempt = 1; ; attempt++) {
    const answer = await askSparkJson(memo, { label: `sound-plan${attempt > 1 ? `-${attempt}` : ''}`, prompt: prompt + feedback });
    const parsed = SoundPlan.safeParse(answer);
    const issues = parsed.success ? planIssues(parsed.data, world, sources) : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    if (!issues.length && parsed.success) return parsed.data;
    if (attempt === 2) {
      if (!parsed.success) throw new Error(`sound plan: ${issues.join('; ')}`);
      return withoutStrayLoops(parsed.data, world); // usable; the step prints what is still missing
    }
    feedback = `\n\nYour last plan had these problems, fix them:\n${issues.map((i) => `- ${i}`).join('\n')}`;
  }
}
