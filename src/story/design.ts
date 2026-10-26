// The story step: world.json becomes story.json. Spark writes it; the checker plays every state
// and sends dead ends and unreachable endings back.
import type { Memo } from '../meta/memo.ts';
import { askSparkJson } from '../meta/spark.ts';
import type { World } from '../world/schema.ts';
import { checkStory, type StoryReport } from './check.ts';
import type { Story } from './schema.ts';

const MIN_STEPS = 6;

const EXAMPLE = `{
  "intro": "two or three sentences shown before the first place",
  "items": [{ "key": "<thing key with role item, or a new key for something given>", "name": "short name" }],
  "locks": [{ "place": "<place>", "via": "<exit thing>", "until": ["<fact>"], "say": "why it will not open yet" }],
  "interactions": [{
    "place": "<place>", "thing": "<thing key in that place>", "verb": "look | use | take | talk",
    "with": "<item key, only when using an item on the thing>",
    "when": ["<fact>"], "say": "what the hero says or sees", "do": [{ "set": "flag" }], "once": false
  }],
  "dialogues": [{
    "npc": "<thing key with role npc>", "place": "<place>", "when": [], "start": "<line key>",
    "lines": [{ "key": "kebab-key", "says": "what the npc says", "choices": [{ "text": "what the hero answers", "when": [], "do": [], "next": "<line key or leave out to end>" }] }]
  }],
  "changes": [{ "place": "<place>", "thing": "<thing key>", "when": ["<fact>"], "looks": "how it looks once changed, a few words" }],
  "endings": [{ "key": "kebab-key", "title": "short", "text": "two sentences" }]
}`;

function brief(world: World): string {
  return `You write the puzzles and dialogue of a short 2D point-and-click adventure. The world is fixed:
${JSON.stringify(world, null, 2)}

Write story.json for it. Rules:
- 3 to 6 minutes of play: 2 to 4 items, 1 or 2 locked exits, one conversation with real choices, 2 endings.
- A fact is "flag", "!flag", "has:item", "!has:item" or "at:place". A condition is a list of facts that must all hold.
- Effects: {"set": flag}, {"clear": flag}, {"give": item}, {"take": item}, {"go": place}, {"ending": ending key}.
- Clicking picks the first interaction listed for that thing, verb and item whose condition holds, so list special cases before the plain one.
- Every thing should answer "look". Every item thing has a "take" with "once": true and gives the item.
- Unlock with a flag set when the problem is solved, not with "has:item", so the player is never locked out after giving the item away.
- When solving something visibly changes a thing (a fire lit, a gate open, a lamp glowing), add a change for it; the painting is updated when its condition holds. At least one change.
- No ending may be reachable in fewer than ${MIN_STEPS} clicks; each ending needs a solved puzzle.
- Every ending must be reachable, and from any state the player must still be able to reach an ending.
- Text is English, short and specific to this world. No names from existing films, books, games or brands.

Reply with JSON only, shaped like:
${EXAMPLE}`;
}

/** Up to four tries; each retry shows Spark its last answer and everything the checker found. */
export async function designStory(memo: Memo, world: World): Promise<{ story: Story; report: StoryReport }> {
  let prompt = brief(world);
  for (let attempt = 1; attempt <= 4; attempt++) {
    const answer = await askSparkJson(memo, { label: `story#${attempt}`, prompt });
    const report = checkStory(world, answer);
    for (const r of report.routes) {
      if (r.steps.length < MIN_STEPS) report.issues.push(`ending "${r.ending}" is reached in only ${r.steps.length} clicks: ${r.steps.join(' → ')}`);
    }
    if (report.story && report.issues.length === 0) return { story: report.story, report };
    console.log(`  story try ${attempt}: ${report.issues.length} issue(s): ${report.issues.slice(0, 3).join('; ')}`);
    prompt = `${brief(world)}\n\nYour last answer was:\n${JSON.stringify(answer)}\n\nA checker played every possible state and found these problems. Fix every one and reply with the whole JSON again:\n- ${report.issues.join('\n- ')}`;
  }
  throw new Error('Spark gave no playable story in 4 tries');
}
