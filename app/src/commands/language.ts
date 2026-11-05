// diorama language <slug> <Language>: the world told in another language. Title, pitch, names and every line of
// the story are translated in one Spark pass; the paintings, masks, sounds and puzzles stay as they are. Then the
// voices are cast again for the new language (no accent of the old one) and every spoken line is read again,
// and the talking faces follow the new takes.
import fs from 'node:fs';
import { defineCommand, registry } from '../registry.ts';
import { castFixesFile, readCastFixes } from '../scene/cast-fixes.ts';
import { SoundPlan } from '../sound/plan.ts';
import { readStoryFixes, StoryFixes, storyFixesFile, textAt } from '../story/fixes.ts';
import { Story } from '../story/schema.ts';
import { kidsWorld } from '../world/drawings.ts';
import { WorldFiles } from '../world/files.ts';
import { applyWorldTexts, languagePlan, planLine, relanguage, translateTexts, worldTexts } from '../world/language.ts';
import { placeSources, soundPlanFrom } from './sound.ts';

const run = (name: string, args: string[]) => registry.get(name)!.run(args);

defineCommand({
  name: 'language',
  usage: 'language <slug> <Language>  tell the world in another language ("English", "Polish"): title, pitch, names and the story translated in one Spark pass, then the voices cast again for that language and every spoken line read again [--text-only: leave the voices for later] [--estimate: only say what it redoes and costs]',
  async run(args) {
    const estimate = args.includes('--estimate');
    const textOnly = args.includes('--text-only');
    const [slug, language] = args.filter((a) => !a.startsWith('--'));
    if (!slug || !language) throw new Error('usage: diorama language <slug> <Language> [--text-only] [--estimate]');
    const files = new WorldFiles(slug);
    const world = files.world();
    const storyFile = files.path('story.json');
    const story = fs.existsSync(storyFile) ? Story.parse(files.readJson(storyFile)) : null;
    const plan = languagePlan(files, world, story, language);
    console.log(`language ${slug}: ${planLine(plan)}`);
    if (estimate) return;

    if (!plan.same) {
      const texts = worldTexts(world, story);
      const kids = kidsWorld(files, world);
      console.log(`translating ${Object.keys(texts).length} texts from ${plan.from} to ${plan.to}`);
      const translated = await translateTexts(files.memo, texts, plan.from, plan.to, kids);
      const now = applyWorldTexts(world, story, translated, plan.to);
      // sound.json is planned from the world and story: the words changed, not what makes a sound, so the plan stays.
      const soundFile = files.path('sound.json');
      const sound = fs.existsSync(soundFile) ? SoundPlan.safeParse(files.readJson(soundFile)) : undefined;
      const sources = sound?.success ? placeSources(files, world) : undefined;
      const soundWasCurrent = sound?.success && sources && sound.data.from === soundPlanFrom(world, story, sources);

      files.write(files.path('world.json'), { ...JSON.parse(fs.readFileSync(files.path('world.json'), 'utf8')), ...now.world, ...(now.world.language ? {} : { language: undefined }) });
      if (now.story) {
        files.write(storyFile, now.story);
        // The person's reworded lines are kept across rebuilds: they are reworded in the new language too.
        const fixes = readStoryFixes(files);
        if (Object.keys(fixes.texts).length) {
          for (const path of Object.keys(fixes.texts)) {
            const text = textAt(now.story, path);
            if (text) fixes.texts[path] = { ...fixes.texts[path], text };
          }
          files.write(storyFixesFile(files), StoryFixes.parse(fixes));
        }
      }
      // A voice the person described for the old language ("Native Polish speaker") is asked for in the new one.
      const castFixes = readCastFixes(files);
      let castChanged = false;
      for (const fix of Object.values(castFixes)) {
        if (fix.voice?.design && fix.voice.design !== relanguage(fix.voice.design, plan.from, plan.to)) {
          fix.voice.design = relanguage(fix.voice.design, plan.from, plan.to);
          castChanged = true;
        }
      }
      if (castChanged) files.write(castFixesFile(files), castFixes);
      if (soundWasCurrent && sound?.success && sources) files.write(soundFile, { ...sound.data, from: soundPlanFrom(files.world(), now.story, sources) });
      for (const id of ['world.title', 'world.pitch']) console.log(`  ${id}: ${translated[id]}`);
      for (const [id, text] of Object.entries(translated).filter(([id]) => id.startsWith('names.'))) console.log(`  ${id.slice(6)}: ${texts[id]} -> ${text}`);
      console.log(`world.json and story.json are in ${plan.to} now`);
    }
    if (textOnly) return void console.log('voices left for later: run_step voices, then faces');
    if (!story) return;
    console.log('\n# voices');
    await run('voices', [slug]);
    if (fs.existsSync(files.path('cast'))) {
      console.log('\n# faces');
      try {
        await run('build', [slug, '--from', 'faces', '--to', 'faces']);
      } catch (error) {
        // Talking mouths are polish: the voices are in, the game plays without them.
        console.log(`faces not made again (${error instanceof Error ? error.message : error}): run_step faces later`);
      }
    }
  },
});
