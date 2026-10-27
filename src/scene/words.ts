// The image safety filter refuses a painting prompt on words, not pictures: "bare trees", seats "hanging on chains"
// in an empty playground read as harm to people. The words that trip it come from Spark's brief, not the person,
// so paint rewords the place (keeping what it shows) and paints again; paint_words lets the person or the agent
// set the wording by hand. Either is kept in corrections.json `words`, read by every later paint.
import type { Memo } from '../meta/memo.ts';
import { askSparkJson } from '../meta/spark.ts';
import type { Place } from '../world/schema.ts';
import type { Brief } from './brief.ts';
import type { Corrections } from './corrections.ts';
import type { Layout } from './layout.ts';

export type Words = NonNullable<Corrections['words']>;

/** Said in every prompt that writes words a painter will get. */
export const SAFE_WORDS = 'The painter runs an image safety filter that refuses whole prompts on single words, even in a harmless scene. '
  + 'Never use words that can read as harm to or exposure of people: say leafless (not bare or naked), seats that rest or sit (not hang, dangle, '
  + 'swing from chains or ropes), no blood, wounds, bodies, corpses, graves, nooses, weapons, guns, killing, death, and no children or kids '
  + '(say small visitors, or leave people out).';

/** The filter's refusal (Meta: 400 content_policy_violation), as opposed to any other failure. */
export const refusedByFilter = (error: unknown) => error instanceof Error && /content_policy_violation|content management policy|safety (system|filter)/i.test(error.message);

/** The place as the painter is told it: the wording's scene and mood, and its looks for things in place of world.json's. */
export function worded(place: Place, words?: Words): Place {
  if (!words) return place;
  return {
    ...place,
    ...(words.shows && { shows: words.shows }),
    ...(words.mood && { mood: words.mood }),
    things: place.things.map((t) => (words.looks[t.key] && t.role !== 'npc' ? { ...t, looks: words.looks[t.key] } : t)),
  };
}

/** Spark's brief with the wording's looks in place of its own, kept word for word. */
export const withWords = (brief: Brief, words?: Words): Brief => (words ? { ...brief, looks: { ...brief.looks, ...words.looks } } : brief);

/** Keys a wording may give a look for: the place's things (not NPCs, who are not painted) and floors. */
export const wordKeys = (place: Place, layout: Pick<Layout, 'floors'>) => [...place.things.filter((t) => t.role !== 'npc').map((t) => t.key), ...layout.floors.map((f) => f.key)];

/**
 * Spark rewords a place the filter refused, keeping every subject what it is. `refusals` counts earlier rewords,
 * so a reword the filter refused again asks anew (the memo keys on the prompt) instead of replaying itself.
 */
export async function reword(memo: Memo, place: Place, layout: Layout, brief: Brief, refusals: number): Promise<Words> {
  const keys = wordKeys(place, layout);
  const prompt = `An image model's safety filter refused to paint this background of a 2D point-and-click adventure${refusals ? ` (${refusals + 1} times now, also after rewording)` : ''}. Nothing in it is harmful: some word read wrongly. Reword it so the same scene is painted.

Place: ${place.shows}
Mood: ${place.mood}
${keys.map((k) => `- ${k}: ${brief.looks[k] ?? ''}`).join('\n')}

${SAFE_WORDS}
Keep every subject the same thing in the same state (an empty swing stays an empty swing: say its seat rests low under its frame). Write calm, plain words; leave out anything that only adds drama. One sentence per subject, each at least ten letters.

Reply with JSON only: {"shows": "...", "mood": "...", "looks": {${keys.map((k) => `"${k}": "..."`).join(', ')}}}`;
  const answer = await askSparkJson<{ shows?: string; mood?: string; looks?: Record<string, string> }>(memo, { label: `reword:${place.key}`, prompt });
  const looks = Object.fromEntries(keys.filter((k) => typeof answer.looks?.[k] === 'string' && answer.looks[k].length >= 10).map((k) => [k, answer.looks![k]]));
  return {
    ...(typeof answer.shows === 'string' && answer.shows.length >= 10 && { shows: answer.shows }),
    ...(typeof answer.mood === 'string' && answer.mood.length >= 2 && { mood: answer.mood }),
    looks,
    by: 'filter',
    tries: refusals + 1,
  };
}
