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

/** Animals that are things of the place: painted into the background, so the painter must not leave them out. */
export const paintedAnimals = (brief?: Brief) => (brief?.alive ?? []).filter((a) => a.as === 'animal').map((a) => a.key);

export function briefIssues(brief: Brief, place: Place, layout: Layout): string[] {
  const keys = [...place.things.filter((t) => t.role !== 'npc').map((t) => t.key), ...layout.floors.map((f) => f.key)];
  return keys.filter((k) => !brief.looks[k]).map((k) => `no look for ${k}`);
}

/** The last word of a cast member's key names what it is ("harbour-cat" → cat, "old-ferryman" → ferryman). */
const castWord = (key: string) => key.split('-').filter((w) => w.length >= 3).pop();

/**
 * Looks that paint one of the place's cast into a thing ("a basket holding a curled-up ginger cat" with a cat
 * in the cast): the game draws its cast over the picture, so that one would be a double. Only when the thing's
 * own words did not name it (its key does not count: a cat-basket is the cat's bed, not a cat).
 */
export function castInLooks(brief: Brief, place: Place): string[] {
  const cast = place.things.filter((t) => t.role === 'npc').map((t) => castWord(t.key)).filter((w): w is string => !!w);
  const out: string[] = [];
  for (const t of place.things.filter((t) => t.role !== 'npc')) {
    const look = brief.looks[t.key];
    if (!look) continue;
    for (const w of cast) {
      const named = new RegExp(`\\b${w}s?\\b`, 'i');
      if (named.test(look) && !named.test(t.looks ?? '')) out.push(`${t.key}'s look paints the ${w}, who is in the cast: leave the ${w} out of it`);
    }
  }
  return out;
}

export async function writeBrief(memo: Memo, world: World, place: Place, layout: Layout): Promise<Brief> {
  const cast = place.things.filter((t) => t.role === 'npc').map((t) => `${t.key}${t.looks ? ` (${t.looks})` : ''}`);
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

Also list which subjects move in the game: water that flows, fire, smoke, animals, cloth in wind, flickering light. They are painted still and animated later, so their look must describe them at rest. An animal among the subjects is painted in, standing still, lying or grazing: describe the animal itself, never an empty spot (nobody else will draw it).

${cast.length ? `The game draws these characters over the picture itself, walking and talking: ${cast.join('; ')}. Never paint them, nor one like them, into any subject's look (no cat curled in a basket that is in this list), even where the place's words put them there: the subject is shown empty, ready for them.\n\n` : ''}Reply with JSON only: {"looks": {"<key>": "..."}, "alive": [{"key": "<key>", "as": "water | fire | smoke | animal | cloth | light"}]}`;
  let brief = Brief.parse(await askSparkJson(memo, { label: `brief:${place.key}`, prompt }));
  // A cast member painted into a thing anyway: asked once more, saying which.
  const doubles = castInLooks(brief, place);
  if (doubles.length) brief = Brief.parse(await askSparkJson(memo, { label: `brief:${place.key}:no-cast`, prompt: `${prompt}\n\nAn earlier answer did this, which is wrong: ${doubles.join('; ')}.` }));
  const issues = briefIssues(brief, place, layout);
  if (issues.length) throw new Error(`brief for ${place.key}: ${issues.join('; ')}`);
  return brief;
}
