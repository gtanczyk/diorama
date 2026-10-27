// brief.json: Spark describes how each thing and floor should look before Muse paints it.
// Muse turns undescribed masses into flat walls and posts, so every mass gets a concrete look.
import { z } from 'zod';
import type { Memo } from '../meta/memo.ts';
import { askSparkJson } from '../meta/spark.ts';
import type { Place, World } from '../world/schema.ts';
import type { Layout } from './layout.ts';
import { SAFE_WORDS } from './words.ts';

export const Brief = z.object({
  looks: z.record(z.string(), z.string().min(10)),
  /** Things that move in the game (water, fire, smoke, animals); painted still, animated later. */
  alive: z.array(z.object({ key: z.string(), as: z.enum(['water', 'fire', 'smoke', 'animal', 'cloth', 'light']) })),
});
export type Brief = z.infer<typeof Brief>;

export function briefIssues(brief: Brief, place: Place, layout: Layout): string[] {
  const keys = [...place.things.filter((t) => t.role !== 'npc').map((t) => t.key), ...layout.floors.map((f) => f.key)];
  return keys.filter((k) => !brief.looks[k]).map((k) => `no look for ${k}`);
}

export async function writeBrief(memo: Memo, world: World, place: Place, layout: Layout): Promise<Brief> {
  const subjects = [
    ...place.things.filter((t) => t.role !== 'npc').map((t) => `${t.key}: ${t.looks} (${t.role})`),
    ...layout.floors.map((f) => `${f.key}: ${f.is} (floor)`),
  ];
  const prompt = `You brief a painter for one background of a 2D point-and-click adventure.

Style: ${world.style}
Place: ${place.shows}
Mood: ${place.mood}

For each subject below write its look in one sentence: shape, material, surface texture, wear, colour in this light. Be concrete enough that nobody could paint it as a plain block.
${subjects.map((s) => `- ${s}`).join('\n')}

${SAFE_WORDS}

Also list which subjects move in the game: water that flows, fire, smoke, animals, cloth in wind, flickering light. They are painted still and animated later, so their look must describe them at rest (an animal is left out of the painting: describe the empty spot it uses).

Reply with JSON only: {"looks": {"<key>": "..."}, "alive": [{"key": "<key>", "as": "water | fire | smoke | animal | cloth | light"}]}`;
  const answer = await askSparkJson(memo, { label: `brief:${place.key}`, prompt });
  const brief = Brief.parse(answer);
  const issues = briefIssues(brief, place, layout);
  if (issues.length) throw new Error(`brief for ${place.key}: ${issues.join('; ')}`);
  return brief;
}
