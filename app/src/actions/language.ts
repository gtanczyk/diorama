// The language a world is told in: world_language translates every word the player reads or hears and has the
// voices cast and read again in it.
import fs from 'node:fs';
import { z } from 'zod';
import { credits } from '../sound/cost.ts';
import { elevenKey } from '../sound/sources.ts';
import { Story } from '../story/schema.ts';
import { agentBlocked } from '../studio/locks.ts';
import { WorldFiles } from '../world/files.ts';
import { languagePlan, planLine } from '../world/language.ts';
import { Slug } from '../world/schema.ts';
import { ActionError, defineAction } from './registry.ts';

defineAction({
  name: 'world_language',
  description: 'Tell the world in another language ("English", "Polish", "German"): the title, pitch, character and item names and every line of the story '
    + '(intro, remarks, dialogue, answers, item names, endings) are translated in one cheap Spark pass, with names kept the same everywhere; the game\'s '
    + 'own words (hints, goodbye, buttons) follow world.json\'s language by themselves. Keys, puzzles, paintings, masks and sounds stay. Then the voices are '
    + 'cast again as native speakers of the new language (no accent of the old one), every spoken line is read again and the talking faces follow. '
    + 'voices false translates only (cheap; the game shows text until run_step voices). Without go it only answers what it redoes and about what '
    + 'it costs: tell the person, then call again with go true once they agree. Runs as a job; history_undo takes it back. Then play_reload.',
  input: z.object({
    slug: Slug,
    language: z.string().trim().min(2).max(30).describe('The new language as its English name: "English", "Polish".'),
    voices: z.boolean().optional().describe('false: translate the text only and leave the voices for later. Default true.'),
    go: z.boolean().optional().describe('true runs it; leave out to get the estimate first.'),
  }),
  job: true,
  async run({ slug, language, voices = true, go }, ctx) {
    const files = new WorldFiles(slug, ctx.root);
    if (!fs.existsSync(files.path('world.json'))) throw new ActionError(404, `no world ${slug} yet`);
    const name = language[0].toUpperCase() + language.slice(1);
    const world = files.world();
    const story = fs.existsSync(files.path('story.json')) ? Story.parse(files.readJson(files.path('story.json'))) : null;
    const plan = languagePlan(files, world, story, name);
    if (!go) {
      const left = await credits(elevenKey());
      return {
        estimate: plan,
        line: voices ? planLine(plan) : `${plan.texts} texts translated from ${plan.from} to ${plan.to} in one Spark pass; voices left for later`,
        ...(left && voices && { elevenLabsCreditsLeft: left.left }),
        next: 'tell the person what it redoes and costs; call again with go: true when they agree',
      };
    }
    const blocked = agentBlocked(files.dir, ctx.by);
    if (blocked) throw new ActionError(423, blocked);
    const busy = ctx.jobs.busy(slug);
    if (busy) throw new ActionError(409, `${busy.label} is ${busy.state}; wait before changing the language`);
    const job = ctx.jobs.start(slug, ['language', slug, name, ...(voices ? [] : ['--text-only'])], `language ${name}`, ctx.by);
    return { job, line: voices ? planLine(plan) : 'text only' };
  },
});
