// The story: places and how exits join them, locks, items, conversations, changes and endings, with the
// checker's verdict and a shortest route to each ending. Lines are reworded in place (story_text); anything
// that changes what the player can do goes back to Spark as a wish (story_redo), so the checker always runs.
import fs from 'node:fs';
import { z } from 'zod';
import { storyLines, Voices } from '../sound/voices.ts';
import { brevityIssues, checkStory, paintingIssues, questionIssues } from '../story/check.ts';
import { applyTexts, readStoryFixes, StoryFixes, storyFixesFile, textAt } from '../story/fixes.ts';
import { Story } from '../story/schema.ts';
import { History } from '../studio/history.ts';
import { agentBlocked } from '../studio/locks.ts';
import { WorldFiles } from '../world/files.ts';
import { Slug } from '../world/schema.ts';
import { ActionError, defineAction, type ActionContext } from './registry.ts';

function open(slug: string, ctx: ActionContext) {
  const files = new WorldFiles(slug, ctx.root);
  if (!fs.existsSync(files.path('world.json'))) throw new ActionError(404, `no world ${slug} yet`);
  return files;
}

const readStory = (files: WorldFiles) => (fs.existsSync(files.path('story.json')) ? Story.parse(files.readJson(files.path('story.json'))) : null);

defineAction({
  name: 'story_status',
  reads: true,
  description: 'The story of a world: places with their exits and things, locks, items, interactions, conversations, changes, optional NPC patrols and endings (story). NPC stages use flags/when; moveNpc effects relocate them after events. Includes '
    + 'the checker\'s issues and a shortest route to each ending, lines over the word limits (long), the person\'s wish and reworded lines (fixes), '
    + 'spoken lines not voiced yet (unvoiced: run_step voices) and changes whose plate is not painted for the current wording (unpainted: run_step plates). '
    + 'Text paths for story_text are dotted, like "dialogues.0.lines.2.says".',
  input: z.object({ slug: Slug }),
  async run({ slug }, ctx) {
    const files = open(slug, ctx);
    const world = files.world();
    const places = world.places.map((p) => ({ key: p.key, shows: p.shows, exits: p.exits, things: p.things.map((t) => ({ key: t.key, role: t.role })) }));
    const story = readStory(files);
    const fixes = readStoryFixes(files);
    if (!story) return { start: world.start, hero: world.hero.key, places, story: null, fixes, issues: [], routes: [], states: 0, long: [], unvoiced: [], unpainted: [] };
    const report = checkStory(world, story);
    const voices = fs.existsSync(files.path('voices.json')) ? Voices.safeParse(files.readJson(files.path('voices.json'))) : null;
    const said = new Set(voices?.success ? voices.data.lines.filter((l) => !l.flags.some((f) => f.startsWith('heard')) && fs.existsSync(files.path(l.file))).map((l) => JSON.stringify([l.speaker, l.text])) : []);
    const unvoiced = storyLines(world, story, world.audience === 'kids').filter((l) => !said.has(JSON.stringify([l.speaker, l.text]))).map((l) => l.text);
    const unpainted = story.changes.flatMap((c, i) => {
      const plate = files.path('places', c.place, 'changes', `${i}.png`);
      const worded = fixes.texts[`changes.${i}.looks`]?.at;
      const painted = fs.existsSync(plate) ? fs.statSync(plate).mtimeMs : 0;
      return fs.existsSync(files.path('places', c.place, 'painting.png')) && (!painted || (worded && Date.parse(worded) > painted)) ? [i] : [];
    });
    return {
      start: world.start, hero: world.hero.key, places, story, fixes,
      issues: report.issues, states: report.states, routes: report.routes.map((r) => ({ ending: r.ending, steps: r.steps })),
      long: brevityIssues(story), unanswerable: questionIssues(story), unseen: paintingIssues(world, story), unvoiced, unpainted,
    };
  },
});

defineAction({
  name: 'story_text',
  description: 'Reword one line of the story: the intro, what the hero says at a thing or a lock, an NPC line, an answer, an item name, an ending, or how a change looks. '
    + 'Path is dotted into story.json ("intro", "interactions.3.say", "dialogues.0.lines.1.choices.0.text", "endings.1.text", "changes.0.looks"). '
    + 'Only wording: what the player can do stays the same. Kept across rebuilds. Spoken lines need run_step voices afterwards, a change\'s looks run_step plates.',
  input: z.object({ slug: Slug, path: z.string().min(1), text: z.string().trim().min(1).max(400) }),
  async run({ slug, path, text }, ctx) {
    const files = open(slug, ctx);
    const blocked = agentBlocked(files.dir, ctx.by);
    if (blocked) throw new ActionError(423, blocked);
    const story = readStory(files);
    if (!story) throw new ActionError(409, `${slug} has no story yet: run_step story first`);
    const before = textAt(story, path);
    if (before === null) throw new ActionError(400, `"${path}" is not a line of the story; story_status lists them`);
    const busy = ctx.jobs.busy(slug);
    if (busy) throw new ActionError(409, `${busy.label} is ${busy.state}; wait before editing story text`);
    new History(files.dir).snapshot(`story text ${path}`, ctx.by);
    const fixes = readStoryFixes(files);
    fixes.texts[path] = { text, at: new Date().toISOString() };
    files.write(storyFixesFile(files), StoryFixes.parse(fixes));
    const now = applyTexts(story, { texts: { [path]: fixes.texts[path] } }).story;
    files.write(files.path('story.json'), now);
    const spoken = storyLines(files.world(), now).some((l) => l.text === text);
    const [kind, i] = path.split('.');
    return { path, before, text, spoken, plate: kind === 'changes' ? now.changes[Number(i)].place : null };
  },
});

defineAction({
  name: 'story_look',
  description: 'Set what the hero says looking at one thing (a sign, a prop, a car), adding the look line where the story has none and rewording it where it has one. '
    + 'Nothing else in the story changes (story_redo would write it all again). Kept across rebuilds. A spoken line needs run_step voices afterwards.',
  input: z.object({ slug: Slug, place: Slug, thing: Slug, text: z.string().trim().min(1).max(400) }),
  async run({ slug, place, thing, text }, ctx) {
    const files = open(slug, ctx);
    const blocked = agentBlocked(files.dir, ctx.by);
    if (blocked) throw new ActionError(423, blocked);
    const story = readStory(files);
    if (!story) throw new ActionError(409, `${slug} has no story yet: run_step story first`);
    const spot = files.world().places.find((p) => p.key === place);
    if (!spot) throw new ActionError(400, `${place} is not a place of ${slug}`);
    if (!spot.things.some((t) => t.key === thing)) throw new ActionError(400, `${thing} is not a thing in ${place}: ${spot.things.map((t) => t.key).join(', ')}`);
    const busy = ctx.jobs.busy(slug);
    if (busy) throw new ActionError(409, `${busy.label} is ${busy.state}; wait before editing story text`);
    new History(files.dir).snapshot(`story look ${place}/${thing}`, ctx.by);
    const fixes = readStoryFixes(files);
    const look = { text, at: new Date().toISOString() };
    fixes.looks = { ...fixes.looks, [`${place}/${thing}`]: look };
    files.write(storyFixesFile(files), StoryFixes.parse(fixes));
    const now = applyTexts(story, { texts: {}, looks: { [`${place}/${thing}`]: look } }).story;
    files.write(files.path('story.json'), now);
    return { place, thing, text, spoken: storyLines(files.world(), now).some((l) => l.text === text) };
  },
});

defineAction({
  name: 'story_redo',
  description: 'Have Spark write the story again to a wish ("the ferrywoman should want something in return", "after receiving the key she goes to the garden and thanks me there"); '
    + 'NPC stages use ordinary flags and conditional dialogue; patrols are optional, and moveNpc effects trigger travel through existing exits. '
    + 'the checker plays every state, so it stays winnable. Reworded lines are dropped, since the lines change. Without a wish, goes back to Spark\'s first story. '
    + 'Runs as a job; afterwards inspect story_status/cast_status. New walkers may need model/sprites; new lines need voices/faces and visual changes need plates.',
  input: z.object({ slug: Slug, wish: z.string().trim().min(5).max(600).optional() }),
  job: true,
  async run({ slug, wish }, ctx) {
    const files = open(slug, ctx);
    const blocked = agentBlocked(files.dir, ctx.by);
    if (blocked) throw new ActionError(423, blocked);
    return ctx.jobs.start(slug, ['story', slug], wish ? 'rewrite story' : 'first story', ctx.by, () => {
      files.write(storyFixesFile(files), StoryFixes.parse({ ...(wish && { wish }), texts: {}, looks: readStoryFixes(files).looks }));
    });
  },
});
