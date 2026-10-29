// Add new workshop drawings to a built world without redesigning its existing places or script.
import fs from 'node:fs';
import { z } from 'zod';
import { readDrawn } from '../world/drawings.ts';
import { WorldFiles } from '../world/files.ts';
import { Slug, World } from '../world/schema.ts';
import { agentBlocked } from '../studio/locks.ts';
import { ActionError, defineAction } from './registry.ts';

export const DrawingFile = z.string().regex(/^drawings\/[a-z0-9-]+\.png$/);
defineAction({
  name: 'world_extend',
  description: 'Extend an existing playable world with drawings already saved by kids_add. files are the drawings/ paths from kids_status, wish is what the person wants. Keeps existing places and story; rebuilds the connecting place and new places, creates new characters and story, and checks playability. Builds in a private copy and installs only on success. Runs as a job; wait with job_wait, inspect the result and reload play only if it succeeds. Costs model calls; the connecting place is repainted. History can undo the job. A drawing already represented by an existing key cannot be added again.',
  input: z.object({ slug: Slug, files: z.array(DrawingFile).min(1).max(8), wish: z.string().trim().min(5).max(2000) }),
  job: true,
  async run({ slug, files: selected, wish }, ctx) {
    const files = new WorldFiles(slug, ctx.root);
    if (!fs.existsSync(files.path('world.json')) || !fs.existsSync(files.path('story.json'))) throw new ActionError(404, 'build the world and story before extending it');
    const blocked = agentBlocked(files.dir, ctx.by);
    if (blocked) throw new ActionError(423, blocked);
    const busy = ctx.jobs.busy(slug);
    if (busy) throw new ActionError(409, `${busy.label} is ${busy.state}; wait before extending`);
    if (new Set(selected).size !== selected.length) throw new ActionError(400, 'each drawing may be selected only once');
    const drawn = readDrawn(files);
    const world = World.parse(files.readJson(files.path('world.json')));
    const known = new Set([world.hero.key, ...world.places.flatMap(p => [p.key, ...p.things.map(t => t.key)])]);
    for (const file of selected) {
      const d = drawn.find(x => `drawings/${x.file}` === file);
      if (!d || !fs.existsSync(files.path(file))) throw new ActionError(404, `${file} is not a saved, read drawing; use kids_add first`);
      if (d.kind === 'hero' || d.kind === 'player') throw new ActionError(400, `${file} is marked ${d.kind}; choose npc, place, item or prop with kids_kind before extending`);
      if (known.has(d.key)) throw new ActionError(409, `${file} refers to ${d.key}, already in the world; it cannot be added again`);
    }
    if (new Set(selected.map(f => drawn.find(d => `drawings/${d.file}` === f)!.key)).size !== selected.length) throw new ActionError(400, 'selected drawings share a key; resolve their identity first');
    return ctx.jobs.start(slug, ['extend', slug, JSON.stringify(selected), wish], 'extend world from drawings', ctx.by);
  },
});
