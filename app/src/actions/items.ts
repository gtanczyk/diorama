// Inventory items: each story item's icon, where it came from (cut from a painting or painted by Muse) and
// the person's fixes. Fixes go to items/fixes.json, so the next build keeps them.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { iconFixesFile, itemSources, ItemsInfo, readIconFixes } from '../scene/icons.ts';
import { Story } from '../story/schema.ts';
import { agentBlocked } from '../studio/locks.ts';
import { WorldFiles } from '../world/files.ts';
import { Slug } from '../world/schema.ts';
import { ActionError, defineAction } from './registry.ts';

const stamp = (file: string) => (fs.existsSync(file) ? Math.round(fs.statSync(file).mtimeMs) : null);

function storyOf(files: WorldFiles): Story {
  if (!fs.existsSync(files.path('story.json'))) throw new ActionError(404, `${files.slug} has no story yet, so no items`);
  return Story.parse(files.readJson(files.path('story.json')));
}

defineAction({
  name: 'icons_status',
  reads: true,
  description: 'Every inventory item of the story: its name, where the hero gets it (picked up from a thing in a place, or handed over), '
    + 'how its icon was made (cut from the painting, redrawn by Muse, or painted by Muse), the icon file and the person\'s fixes.',
  input: z.object({ slug: Slug }),
  async run({ slug }, ctx) {
    const files = new WorldFiles(slug, ctx.root);
    const story = storyOf(files);
    const sources = itemSources(story);
    const infoFile = files.path('items', 'items.json');
    const info = fs.existsSync(infoFile) ? ItemsInfo.parse(files.readJson(infoFile)) : {};
    const fixes = readIconFixes(files);
    return story.items.map((item) => {
      const file = `items/${item.key}.png`;
      return {
        key: item.key,
        name: item.name,
        from: sources[item.key],
        how: info[item.key]?.how ?? null,
        icon: fs.existsSync(files.path(file)) ? { file, v: stamp(files.path(file)) } : null,
        fix: fixes[item.key] ?? null,
      };
    });
  },
});

defineAction({
  name: 'icon_redo',
  description: 'Make an item\'s inventory icon again: with a hint in the person\'s words of how it should look (Muse redraws it), '
    + 'how to make it (cut: from the painting where it is picked up; paint: Muse paints it), or simply another take. Kept across rebuilds. Runs as a job.',
  input: z.object({
    slug: Slug,
    item: z.string().min(1),
    how: z.enum(['cut', 'paint']).optional(),
    hint: z.string().min(3).optional(),
    anotherTake: z.boolean().optional(),
  }),
  job: true,
  async run({ slug, item, how, hint, anotherTake }, ctx) {
    if (!how && !hint && !anotherTake) throw new ActionError(400, 'give how, a hint, or anotherTake: true');
    const files = new WorldFiles(slug, ctx.root);
    const story = storyOf(files);
    if (!story.items.some((i) => i.key === item)) throw new ActionError(404, `${slug} has no item ${item}: ${story.items.map((i) => i.key).join(', ')}`);
    if (how === 'cut' && !itemSources(story)[item]) throw new ActionError(400, `${item} is handed over, not picked up anywhere, so there is nothing to cut it from`);
    const blocked = agentBlocked(files.dir, ctx.by);
    if (blocked) throw new ActionError(423, blocked);
    return ctx.jobs.start(slug, ['icons', slug, item], `icon ${item}`, ctx.by, () => {
      const fixes = readIconFixes(files);
      const fix = (fixes[item] ??= {});
      if (how) fix.how = how;
      if (hint) fix.hint = hint;
      if (anotherTake) fix.take = (fix.take ?? 0) + 1;
      fs.mkdirSync(path.dirname(iconFixesFile(files)), { recursive: true });
      files.write(iconFixesFile(files), fixes);
    });
  },
});

defineAction({
  name: 'icon_fix_clear',
  description: 'Take back the person\'s fixes to an item\'s icon (hint, how, take) and make it again the default way. Runs as a job.',
  input: z.object({ slug: Slug, item: z.string().min(1) }),
  job: true,
  async run({ slug, item }, ctx) {
    const files = new WorldFiles(slug, ctx.root);
    const blocked = agentBlocked(files.dir, ctx.by);
    if (blocked) throw new ActionError(423, blocked);
    return ctx.jobs.start(slug, ['icons', slug, item], `icon ${item}`, ctx.by, () => {
      const fixes = readIconFixes(files);
      delete fixes[item];
      if (fs.existsSync(iconFixesFile(files))) files.write(iconFixesFile(files), fixes);
    });
  },
});
