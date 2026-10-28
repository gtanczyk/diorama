// Weather: what falls on a place and what drips there (the weather step), as the author wants it.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { WeatherWish } from '../play/weather.ts';
import { agentBlocked } from '../studio/locks.ts';
import { Slug } from '../world/schema.ts';
import { ActionError, defineAction } from './registry.ts';

defineAction({
  name: 'weather_set',
  description: 'Set the weather of a place when the person says it should (not) rain or snow there, it falls too hard or too lightly, '
    + 'or water should drip from something: fall auto (as Spark reads the picture and the mood), none, rain or snow; strength 0..1 '
    + '(0.3 drizzle, 1 downpour); fog 0..1 when mist should (not) drift there (0 clear, 0.3 haze, 0.7 thick fog); a hint in their words ("water drips from the tavern sign"). Kept in places/<place>/weather-wish.json '
    + 'across rebuilds; reruns the weather step of that place as a job.',
  input: z.object({
    slug: Slug,
    place: z.string().min(1),
    fall: z.enum(['auto', 'none', 'rain', 'snow']),
    strength: z.number().min(0).max(1).optional(),
    fog: z.number().min(0).max(1).optional().describe('Mist drifting over the place: 0 none, 0.3 haze, 0.7 thick fog.'),
    hint: z.string().min(3).optional().describe('What should drip or fall, in words, for Spark to follow.'),
  }),
  job: true,
  async run({ slug, place, fall, strength, fog, hint }, ctx) {
    const dir = path.join(ctx.root, slug);
    const blocked = agentBlocked(dir, ctx.by);
    if (blocked) throw new ActionError(423, blocked);
    const placeDir = path.join(dir, 'places', place);
    if (!fs.existsSync(path.join(placeDir, 'geometry.json'))) throw new ActionError(404, `${slug}/${place} has no geometry yet: build it first`);
    const file = path.join(placeDir, 'weather-wish.json');
    return ctx.jobs.start(slug, ['weather', slug, place], `weather ${place}: ${fall}`, ctx.by, () => {
      const was = fs.existsSync(file) ? WeatherWish.parse(JSON.parse(fs.readFileSync(file, 'utf8'))) : WeatherWish.parse({});
      const wish: WeatherWish = { ...was, fall, ...(strength !== undefined && { strength }), ...(fog !== undefined && { fog }), ...(hint !== undefined && { hint }) };
      fs.writeFileSync(file, `${JSON.stringify(wish, null, 2)}\n`);
    });
  },
});
