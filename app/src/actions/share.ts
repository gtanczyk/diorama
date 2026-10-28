// Sharing a world: a zip to download (itch.io, e-mail) or the public link on GitHub Pages, as jobs.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Slug } from '../world/schema.ts';
import { ActionError, defineAction } from './registry.ts';

const playable = (root: string, slug: string) => {
  if (!fs.existsSync(path.join(root, slug, 'world.json'))) throw new ActionError(404, `no world ${slug} yet`);
};

defineAction({
  name: 'world_export',
  description: 'Pack a playable copy of the world as a zip the person can download from the Studio (for itch.io or e-mail). Runs as a job.',
  input: z.object({ slug: Slug }),
  job: true,
  async run({ slug }, ctx) {
    playable(ctx.root, slug);
    return ctx.jobs.start(slug, ['export', slug, '--zip'], 'export a zip', ctx.by);
  },
});

defineAction({
  name: 'world_publish',
  description: 'Put the world on the public web (GitHub Pages of this repository) and get its link. Anyone can play it there: ask the person before you call this. Runs as a job.',
  input: z.object({ slug: Slug }),
  job: true,
  async run({ slug }, ctx) {
    playable(ctx.root, slug);
    return ctx.jobs.start(slug, ['publish', slug], 'publish to GitHub Pages', ctx.by);
  },
});
