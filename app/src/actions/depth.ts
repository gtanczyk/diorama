// Depth: how a place moves as a diorama (the backdrop step's parallax layers, flowing water and drifting painted fog).
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Depth } from '../scene/layers.ts';
import { parseCell } from '../scene/locate.ts';
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
    return ctx.jobs.start(slug, ['backdrop', slug, place], `water ${place}: ${flow}`, ctx.by, () => {
      const was = fs.existsSync(file) ? Depth.parse(JSON.parse(fs.readFileSync(file, 'utf8'))) : Depth.parse({});
      const depth: Depth = { ...was, flow, ...(hint !== undefined && { flowHint: hint }) };
      fs.writeFileSync(file, `${JSON.stringify(depth, null, 2)}\n`);
    });
  },
});

const Cell = z.string().refine((c) => !!parseCell(c), 'a grid cell like C12: a letter per 60 px column from A, a number per 60 px row from 1');

defineAction({
  name: 'water_area',
  description: 'Say which 60 px grid cells are water that should move (add) or are not water (remove), when the person says only part of '
    + 'a river, lake or sea moves, or something that is not water ripples. Cells are named like C12 (column letter from A at the left, '
    + 'row number from 1 at the top, as on the grid of place_view). An added cell flows along the edge SAM sees there, or whole. '
    + 'Kept in places/<place>/depth.json across rebuilds; reruns the backdrop step of that place as a job.',
  input: z.object({ slug: Slug, place: z.string().min(1), add: z.array(Cell).optional(), remove: z.array(Cell).optional() }),
  job: true,
  async run({ slug, place, add, remove }, ctx) {
    if (!add?.length && !remove?.length) throw new ActionError(400, 'give cells to add or remove');
    const dir = path.join(ctx.root, slug);
    const blocked = agentBlocked(dir, ctx.by);
    if (blocked) throw new ActionError(423, blocked);
    const placeDir = path.join(dir, 'places', place);
    if (!fs.existsSync(path.join(placeDir, 'geometry.json'))) throw new ActionError(404, `${slug}/${place} has no geometry yet: build it first`);
    const file = path.join(placeDir, 'depth.json');
    const up = (cells?: string[]) => (cells ?? []).map((c) => c.trim().toUpperCase());
    return ctx.jobs.start(slug, ['backdrop', slug, place], `water area ${place}`, ctx.by, () => {
      const was = fs.existsSync(file) ? Depth.parse(JSON.parse(fs.readFileSync(file, 'utf8'))) : Depth.parse({});
      const depth: Depth = {
        ...was,
        waterAdd: [...new Set([...was.waterAdd.filter((c) => !up(remove).includes(c)), ...up(add)])],
        waterRemove: [...new Set([...was.waterRemove.filter((c) => !up(add).includes(c)), ...up(remove)])],
      };
      fs.writeFileSync(file, `${JSON.stringify(depth, null, 2)}\n`);
    });
  },
});

defineAction({
  name: 'fog_drift',
  description: 'Set how the fog or mist painted into a place drifts (the backdrop step cuts it with SAM and the page slides it), '
    + 'when the person says the fog stands still, drifts the wrong way, or too fast or slow: auto (with the wind), left, right, '
    + 'or still (stays as painted), and speed 0.25..3 (1 by default). Kept in places/<place>/depth.json across rebuilds; reruns the backdrop step of that place as a job. '
    + 'For extra mist that is not in the picture, use weather_set fog.',
  input: z.object({
    slug: Slug,
    place: z.string().min(1),
    drift: z.enum(['auto', 'left', 'right', 'still']),
    speed: z.number().min(0.25).max(3).optional().describe('How fast it drifts: 0.5 slow, 1 as by default, 2 rolling.'),
  }),
  job: true,
  async run({ slug, place, drift, speed }, ctx) {
    const dir = path.join(ctx.root, slug);
    const blocked = agentBlocked(dir, ctx.by);
    if (blocked) throw new ActionError(423, blocked);
    const placeDir = path.join(dir, 'places', place);
    if (!fs.existsSync(path.join(placeDir, 'geometry.json'))) throw new ActionError(404, `${slug}/${place} has no geometry yet: build it first`);
    const file = path.join(placeDir, 'depth.json');
    return ctx.jobs.start(slug, ['backdrop', slug, place], `fog ${place}: ${drift}${speed !== undefined ? ` x${speed}` : ''}`, ctx.by, () => {
      const was = fs.existsSync(file) ? Depth.parse(JSON.parse(fs.readFileSync(file, 'utf8'))) : Depth.parse({});
      const depth: Depth = { ...was, fog: drift, ...(speed !== undefined && { fogSpeed: speed }) };
      fs.writeFileSync(file, `${JSON.stringify(depth, null, 2)}\n`);
    });
  },
});
