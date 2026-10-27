// diorama story <slug>: puzzles, items, dialogue and endings for world.json, checked by playing every state.
// The person's wish and reworded lines (story-fixes.json) are applied every time.
// diorama story <slug> --check: re-check story.json.
import { defineCommand } from '../registry.ts';
import { checkStory } from '../story/check.ts';
import { designStory } from '../story/design.ts';
import { applyTexts, readStoryFixes } from '../story/fixes.ts';
import { WorldFiles } from '../world/files.ts';

defineCommand({
  name: 'story',
  usage: 'story <slug>            write story.json with Muse Spark and check every ending is reachable [--check]',
  async run(args) {
    const checkOnly = args.includes('--check');
    const [slug] = args.filter((a) => !a.startsWith('--'));
    if (!slug) throw new Error('usage: diorama story <slug> [--check]');
    const files = new WorldFiles(slug);
    const world = files.world();
    const fixes = readStoryFixes(files);
    let report;
    if (checkOnly) report = checkStory(world, files.readJson(files.path('story.json')));
    else {
      if (fixes.wish) console.log(`  your wish: ${fixes.wish}`);
      const designed = await designStory(files.memo, world, fixes.wish);
      const { story, skipped } = applyTexts(designed.story, fixes);
      for (const path of skipped) console.log(`  your wording for ${path} no longer fits the story; left out`);
      if (Object.keys(fixes.texts).length > skipped.length) console.log(`  ${Object.keys(fixes.texts).length - skipped.length} line(s) in your wording`);
      files.write(files.path('story.json'), story);
      report = checkStory(world, story);
    }
    if (report.issues.length) throw new Error(`story.json has ${report.issues.length} issue(s):\n- ${report.issues.join('\n- ')}`);
    files.write(files.path('routes.json'), report.routes);
    console.log(`${report.states} states played, every ending reachable, no dead ends`);
    for (const r of report.routes) console.log(`  ${r.ending} in ${r.steps.length} steps: ${r.steps.join(' → ')}`);
    if (!checkOnly) console.log(`spark calls sent: ${files.memo.sent.spark}`);
  },
});
