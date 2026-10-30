import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Slug } from '../world/schema.ts';
import { agentBlocked } from '../studio/locks.ts';
import { ActionError, defineAction } from './registry.ts';

defineAction({
  name: 'reactions_set',
  description: 'Choose or adjust subtle scene reactions: footsteps on each surface, crossing a local floor area, and physical use/take interactions. A hint in the author\'s words guides the automatic vision-language planner; use "choose automatically" to reset the preference. Keeps the hint across rebuilds, runs reactions for this place, then play_reload. It never repaints the scene.',
  input: z.object({ slug: Slug, place: Slug, hint: z.string().min(3).max(2000) }),
  job: true,
  async run({ slug, place, hint }, ctx) {
    const dir = path.join(ctx.root, slug), blocked = agentBlocked(dir, ctx.by);
    if (blocked) throw new ActionError(423, blocked);
    const at = path.join(dir, 'places', place);
    if (!fs.existsSync(path.join(at, 'geometry.json'))) throw new ActionError(404, `${place} has no geometry yet`);
    return ctx.jobs.start(slug, ['reactions', slug, place], `reactions ${place}`, ctx.by, () => {
      fs.writeFileSync(path.join(at, 'reactions-wish.json'), JSON.stringify({ hint }, null, 2) + '\n');
    });
  },
});
defineAction({
  name: 'reactions_status', reads: true,
  description: 'Read the chosen scene reactions and author preference. Area cells are summarized; triggers list step/enter and exact story interactions. Missing means the reactions step has not run.',
  input: z.object({ slug: Slug, place: Slug }),
  async run({ slug, place }, ctx) {
    const at = path.join(ctx.root, slug, 'places', place), file = path.join(at, 'reactions.json');
    const wish = path.join(at, 'reactions-wish.json');
    const hint = fs.existsSync(wish) ? JSON.parse(fs.readFileSync(wish, 'utf8')).hint : undefined;
    if (!fs.existsSync(file)) return { made: false, hint };
    const { Reactions } = await import('../play/reactions.ts');
    const rules = Reactions.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    return { made: true, hint, ...rules, areas: rules.areas.map(({ cells, ...a }) => ({ ...a, cells: cells.reduce((n, row) => n + [...row].filter((c) => c === '#').length, 0) })) };
  },
});
