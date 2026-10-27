// The world step: a prompt becomes world.json. Spark designs it; the gate sends problems back.
import type { Memo } from '../meta/memo.ts';
import { askSparkJson } from '../meta/spark.ts';
import { checkWorld, type Place, type World } from './schema.ts';

const EXAMPLE = `{
  "title": "...",
  "pitch": "two sentences for the back of the box",
  "style": "one painting style for every place: medium, palette, light (no artist names)",
  "start": "<place key>",
  "hero": { "key": "kebab-key", "looks": "the hero head to toe" },
  "places": [{
    "key": "kebab-key",
    "shows": "what the painting of this place shows, front to back",
    "mood": "time of day, weather, feeling",
    "things": [{ "key": "kebab-key", "role": "prop | exit | item | npc", "looks": "a few words" }],
    "exits": [{ "to": "<place key>", "via": "<key of a thing with role exit here>" }]
  }]
}`;

function brief(idea: string, places: number, fixed?: Place, extra = ''): string {
  const first = fixed
    ? `\nThe first place is a real room from a photo and is fixed. It is the start; copy its key, shows, mood and things unchanged and only add exits through its exit things:\n${JSON.stringify(fixed)}\n`
    : '';
  return `You design worlds for a 2D point-and-click adventure. Each place is one painted background seen from a fixed camera, slightly from above, with open floor the hero walks on.

The idea:
"""
${idea}
"""

${first}
${extra ? `${extra}

` : ''}Design ${places} places that tell this idea${fixed ? ', the room included' : ''}. Rules:
- 3 to 7 things per place, big enough to see and click; no tiny details.
- Exits are things you can see (door, path, ladder, boat) and every exit has one back.
- The world has at least one item to pick up and one npc to talk to.
- Everything is original: no characters, places or names from existing films, books, games or brands.

Reply with JSON only, shaped like:
${EXAMPLE}`;
}

/** More to ask of the world than the idea: a brief part, and what to check the answer for. */
export type Extra = { brief: string; issues: (world: World) => string[] };

/** Up to three tries: the second and third show Spark its last answer and what was wrong with it. */
export async function designWorld(memo: Memo, idea: string, places = 4, fixed?: Place, extra?: Extra): Promise<World> {
  let prompt = brief(idea, places, fixed, extra?.brief);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const answer = await askSparkJson(memo, { label: `world#${attempt}`, prompt });
    const checked = checkWorld(fixed ? keepFixed(answer, fixed) : answer);
    const { world } = checked;
    const issues = world && extra ? extra.issues(world) : checked.issues;
    if (world && issues.length === 0) return world;
    console.log(`  world try ${attempt}: ${issues.length} issue(s): ${issues.slice(0, 4).join('; ')}`);
    prompt = `${brief(idea, places, fixed, extra?.brief)}\n\nYour last answer was:\n${JSON.stringify(answer)}\n\nFix every one of these and reply with the whole JSON again:\n- ${issues.join('\n- ')}`;
  }
  throw new Error('Spark gave no valid world in 3 tries');
}

/** The photo room is what the photo shows, whatever Spark wrote: only its exits come from the answer. */
function keepFixed(answer: unknown, fixed: Place): unknown {
  const world = answer as { start?: string; places?: { key?: string; exits?: unknown }[] };
  if (!Array.isArray(world?.places)) return answer;
  const at = world.places.findIndex((p) => p?.key === fixed.key);
  const exits = at >= 0 ? world.places[at].exits : [];
  const places = at >= 0 ? world.places.map((p, i) => (i === at ? { ...fixed, exits } : p)) : [{ ...fixed, exits }, ...world.places];
  return { ...world, start: fixed.key, places };
}
