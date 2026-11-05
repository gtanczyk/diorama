// The look of a world: style_set changes it for the whole world, one place or the cast, and repaints what is made.
import fs from 'node:fs';
import { z } from 'zod';
import { readCastFixes } from '../scene/cast-fixes.ts';
import { readCorrections } from '../scene/corrections.ts';
import { agentBlocked } from '../studio/locks.ts';
import { kidsWorld } from '../world/drawings.ts';
import { WorldFiles } from '../world/files.ts';
import { Slug } from '../world/schema.ts';
import { castKeys, planLine, SCOPES, stylePlan } from '../world/style-plan.ts';
import { readStyled } from '../world/styled.ts';
import { ActionError, defineAction } from './registry.ts';

defineAction({
  name: 'style_get',
  reads: true,
  description: 'The painting style of a world: world.json\'s, each place\'s and character\'s own where one was set, and the style each was last painted in.',
  input: z.object({ slug: Slug }),
  async run({ slug }, ctx) {
    const files = new WorldFiles(slug, ctx.root);
    if (!fs.existsSync(files.path('world.json'))) throw new ActionError(404, `no world ${slug} yet`);
    const world = files.world();
    const fixes = readCastFixes(files);
    return {
      style: world.style,
      kids: kidsWorld(files, world),
      places: Object.fromEntries(world.places.map((p) => [p.key, readCorrections(files.place(p.key)).style ?? null])),
      cast: Object.fromEntries(castKeys(world, files).map((k) => [k, fixes[k]?.style ?? null])),
      painted: readStyled(files),
    };
  },
});

defineAction({
  name: 'style_set',
  description: 'Change the painting style ("realistic oil painting, soft natural light, muted palette"): of the whole world (scope world, the default), '
    + 'one place (scope place, key = place) or the cast (scope cast, key = one character or leave out for all). Every place is repainted from its '
    + 'painting with the composition kept (one Muse edit), then cut out and measured again; characters are repainted from their figure, keeping '
    + 'who they are, and their 3D models and sprite sheets made again. Children\'s drawings stay the reference. Without go it only answers what it '
    + 'redoes and about what it costs: tell the person, then call again with go true once they agree. Runs as a job; history_undo takes it back.',
  input: z.object({
    slug: Slug,
    style: z.string().min(10).describe('The new style in a few words: medium, palette, light, no artist names.'),
    scope: z.enum(SCOPES).optional(),
    key: Slug.optional().describe('The place (scope place) or the character (scope cast).'),
    go: z.boolean().optional().describe('true runs it; leave out to get the estimate first.'),
  }),
  job: true,
  async run({ slug, style, scope = 'world', key, go }, ctx) {
    const files = new WorldFiles(slug, ctx.root);
    if (!fs.existsSync(files.path('world.json'))) throw new ActionError(404, `no world ${slug} yet`);
    const world = files.world();
    if (scope === 'place' && !world.places.some((p) => p.key === key)) throw new ActionError(400, `scope place needs key, one of ${world.places.map((p) => p.key).join(', ')}`);
    if (scope === 'cast' && key && !castKeys(world, files).includes(key)) throw new ActionError(404, `${slug} has no character ${key}: ${castKeys(world, files).join(', ')}`);
    if (scope === 'world' && key) throw new ActionError(400, 'scope world takes no key');
    const plan = stylePlan(files, world, scope, key);
    const kids = kidsWorld(files, world);
    if (!go) {
      return {
        estimate: plan,
        line: planLine(plan),
        was: scope === 'place' ? readCorrections(files.place(key!)).style ?? world.style : world.style,
        ...(kids && { note: 'made from children\'s drawings: they stay the reference, so the children still know their things' }),
        next: 'tell the person what it redoes and costs; call again with go: true when they agree',
      };
    }
    const blocked = agentBlocked(files.dir, ctx.by, scope === 'place' ? key : undefined);
    if (blocked) throw new ActionError(423, blocked);
    const args = ['style', slug, style, ...(scope === 'place' ? ['--place', key!] : scope === 'cast' ? ['--cast', key ?? 'all'] : [])];
    const job = ctx.jobs.start(slug, args, `style ${scope}${key ? ` ${key}` : ''}`, ctx.by);
    return { job, line: planLine(plan) };
  },
});
