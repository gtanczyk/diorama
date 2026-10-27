// world.json: the places of a world and how they connect. Spark writes it, people may edit it.
import { z } from 'zod';

export const Slug = z.string().regex(/^[a-z][a-z0-9-]*$/, 'lowercase-kebab key');

export const Thing = z.object({
  key: Slug,
  role: z.enum(['prop', 'exit', 'item', 'npc']),
  looks: z.string().min(3),
});

export const Place = z.object({
  key: Slug,
  shows: z.string().min(10),
  mood: z.string().min(3),
  things: z.array(Thing).min(1).max(10),
  exits: z.array(z.object({ to: Slug, via: Slug })),
});

export const World = z.object({
  title: z.string().min(1),
  pitch: z.string().min(10),
  style: z.string().min(10),
  start: Slug,
  hero: z.object({ key: Slug, looks: z.string().min(10) }),
  places: z.array(Place).min(1).max(8),
  /** The language the game's text is written and voiced in, as a name ("Polish"); English when left out. */
  language: z.string().min(2).optional(),
  /** Who plays: "kids" are 5 to 7 and cannot read yet, so the story is gentler, simpler and heard. */
  audience: z.enum(['kids']).optional(),
});

export type World = z.infer<typeof World>;
export type Place = z.infer<typeof Place>;

/** What a schema can't say: exits must lead somewhere and back, and every place must be reachable. */
export function worldIssues(world: World): string[] {
  const issues: string[] = [];
  const byKey = new Map(world.places.map((p) => [p.key, p]));
  if (byKey.size < world.places.length) issues.push('place keys repeat');
  if (!byKey.has(world.start)) issues.push(`start "${world.start}" is not a place`);
  for (const place of world.places) {
    const keys = place.things.map((t) => t.key);
    if (new Set(keys).size < keys.length) issues.push(`${place.key}: thing keys repeat`);
    for (const exit of place.exits) {
      const target = byKey.get(exit.to);
      const via = place.things.find((t) => t.key === exit.via);
      if (!target) issues.push(`${place.key}: exit leads to unknown place "${exit.to}"`);
      if (!via) issues.push(`${place.key}: exit uses "${exit.via}", which is not one of its things`);
      else if (via.role !== 'exit') issues.push(`${place.key}: "${exit.via}" is used as an exit, so its role must be "exit"`);
      if (target && !target.exits.some((back) => back.to === place.key)) issues.push(`${exit.to} has no exit back to ${place.key}`);
    }
  }
  const reached = new Set<string>();
  const visit = (key: string) => {
    if (reached.has(key) || !byKey.has(key)) return;
    reached.add(key);
    byKey.get(key)!.exits.forEach((e) => visit(e.to));
  };
  visit(world.start);
  for (const place of world.places) if (!reached.has(place.key)) issues.push(`${place.key} cannot be reached from ${world.start}`);
  return issues;
}

export function checkWorld(raw: unknown): { world?: World; issues: string[] } {
  const parsed = World.safeParse(raw);
  if (!parsed.success) return { issues: parsed.error.issues.map((i) => `${i.path.join('.') || 'world'}: ${i.message}`) };
  const issues = worldIssues(parsed.data);
  return issues.length ? { issues } : { world: parsed.data, issues };
}
