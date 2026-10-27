// Depth: how a place moves as a diorama (the backdrop step's parallax layers and flowing water).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Depth } from '../scene/layers.ts';
import { agentBlocked } from '../studio/locks.ts';
import { Slug } from '../world/schema.ts';
import { ActionError, defineAction } from './registry.ts';

defineAction({
  name: 'water_flow',
  description: 'Set which way the water of a place flows, when the person says it runs the wrong way or should not flow: '
    + 'reverse (the other way round), still (a pond, a harbour basin), or auto (as Spark reads the picture), with an optional hint in words '
    + '("downstream is toward the bridge"). Kept in places/<place>/depth.json across rebuilds; reruns the backdrop step of that place as a job.',
  input: z.object({
    slug: Slug,
    place: z.string().min(1),
    flow: z.enum(['auto', 'reverse', 'still']),
    hint: z.string().min(3).optional().describe('Where the water runs, in words, for Spark to follow.'),
  }),
  job: true,
  async run({ slug, place, flow, hint }, ctx) {
    const dir = path.join(ctx.root, slug);
    const blocked = agentBlocked(dir, ctx.by);
    if (blocked) throw new ActionError(423, blocked);
    const placeDir = path.join(dir, 'places', place);
    if (!fs.existsSync(path.join(placeDir, 'geometry.json'))) throw new ActionError(404, `${slug}/${place} has no geometry yet: build it first`);
    const file = path.join(placeDir, 'depth.json');
    const was = fs.existsSync(file) ? Depth.parse(JSON.parse(fs.readFileSync(file, 'utf8'))) : Depth.parse({});
    const depth: Depth = { ...was, flow, ...(hint !== undefined && { flowHint: hint }) };
    fs.writeFileSync(file, `${JSON.stringify(depth, null, 2)}\n`);
    return ctx.jobs.start(slug, ['backdrop', slug, place], `water ${place}: ${flow}`, ctx.by);
  },
});
