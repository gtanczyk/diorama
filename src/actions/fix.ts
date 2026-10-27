// Fixing a place: each fix is written to places/<place>/corrections.json, then the place is rebuilt
// from the step the fix feeds, so the next full build keeps it. The agent gets the same tools.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Corrections, readCorrections, RectIn, Stroke, writeCorrections } from '../scene/corrections.ts';
import { KINDS, parseCell } from '../scene/locate.ts';
import { agentBlocked } from '../studio/locks.ts';
import { Slug } from '../world/schema.ts';
import { ActionError, defineAction, type ActionContext } from './registry.ts';

const XY = z.tuple([z.number(), z.number()]);
const Cell = z.string().refine((c) => !!parseCell(c), 'a grid cell like C12: a letter per 60 px column from A, a number per 60 px row from 1');

/** Applies a change to a place's corrections and rebuilds that place from `from` to verify, as a job. */
async function fixPlace(ctx: ActionContext, slug: string, place: string, from: 'paint' | 'masks' | 'derive', label: string, change: (c: Corrections) => void) {
  const dir = path.join(ctx.root, slug);
  const blocked = agentBlocked(dir, ctx.by, place);
  if (blocked) throw new ActionError(423, blocked);
  // The agent's repair limit: after three fixes in a row that left the place unplayable, it is the person's turn.
  if (ctx.by === 'agent') {
    const since = new Date(Date.now() - 30 * 60_000).toISOString();
    const tries = ctx.jobs.list(slug).filter((j) => j.by === 'agent' && j.args.includes('--place') && j.args[j.args.indexOf('--place') + 1] === place && (j.queuedAt ?? '') >= since);
    const lastOk = tries.findLastIndex((j) => j.state === 'done');
    if (tries.slice(lastOk + 1).filter((j) => j.state === 'failed').length >= 3) {
      throw new ActionError(429, `three fixes of ${place} in a row left it unplayable: stop here and tell the person what you tried and what you would do next`);
    }
  }
  const placeDir = path.join(dir, 'places', place);
  const needs = { paint: 'blockin.png', masks: 'painting.png', derive: 'masks.json' }[from];
  if (!fs.existsSync(path.join(placeDir, needs))) throw new ActionError(404, `${slug}/${place} has no ${needs} yet: build it first`);
  const fixes = readCorrections(placeDir);
  change(fixes);
  writeCorrections(placeDir, Corrections.parse(fixes));
  return ctx.jobs.start(slug, ['build', slug, '--from', from, '--to', 'verify', '--place', place], `${label} · ${place}`, ctx.by);
}

const thingOf = (c: Corrections, key: string) => (c.things[key] ??= { strokes: [] });
const floorOf = (c: Corrections, key: string) => (c.floors[key] ??= { add: [], remove: [], strokes: [] });

defineAction({
  name: 'corrections_get',
  reads: true,
  description: 'The fixes the person (or you) made to a place so far: SAM phrases, boxes, kinds, brush strokes, floor cells, stand spots, repaints.',
  input: z.object({ slug: Slug, place: z.string().min(1) }),
  async run({ slug, place }, ctx) {
    return readCorrections(path.join(ctx.root, slug, 'places', place));
  },
});

defineAction({
  name: 'mask_fix',
  description: 'Fix how a thing is found in the painting: a better name for SAM to search ("wooden rowing boat"), the box where it really is, '
    + 'or its kind (standing: people walk around and behind it; wall: on the backdrop; on-top; walk-on; flat). Reruns masks to verify for that place.',
  input: z.object({
    slug: Slug,
    place: z.string().min(1),
    thing: z.string().min(1),
    phrase: z.string().min(2).optional(),
    box: RectIn.optional(),
    kind: z.enum(KINDS).optional(),
  }),
  job: true,
  async run({ slug, place, thing, phrase, box, kind }, ctx) {
    if (!phrase && !box && !kind) throw new ActionError(400, 'give a phrase, a box or a kind');
    return fixPlace(ctx, slug, place, 'masks', `fix ${thing}`, (c) => {
      const t = thingOf(c, thing);
      if (phrase) t.phrase = phrase;
      if (box) t.box = box;
      if (kind) t.kind = kind;
    });
  },
});

defineAction({
  name: 'mask_brush',
  description: 'Paint onto or erase from the mask of a thing or a floor with round brush strokes (painting pixels, 1200x896). Kept across rebuilds; reruns masks to verify for that place.',
  input: z.object({
    slug: Slug,
    place: z.string().min(1),
    layer: z.enum(['thing', 'floor']),
    key: z.string().min(1),
    strokes: z.array(Stroke).min(1).max(50),
  }),
  job: true,
  async run({ slug, place, layer, key, strokes }, ctx) {
    return fixPlace(ctx, slug, place, 'masks', `brush ${key}`, (c) => {
      (layer === 'thing' ? thingOf(c, key) : floorOf(c, key)).strokes.push(...strokes);
    });
  },
});

defineAction({
  name: 'floor_cells',
  description: 'Say which 60 px grid cells are (add) or are not (remove) a floor people walk on, when Spark marked them wrong; cells are named like C12 '
    + '(column letter from A at the left, row number from 1 at the top). Reruns masks to verify for that place.',
  input: z.object({ slug: Slug, place: z.string().min(1), floor: z.string().min(1), add: z.array(Cell).optional(), remove: z.array(Cell).optional() }),
  job: true,
  async run({ slug, place, floor, add, remove }, ctx) {
    if (!add?.length && !remove?.length) throw new ActionError(400, 'give cells to add or remove');
    return fixPlace(ctx, slug, place, 'masks', `floor ${floor}`, (c) => {
      const f = floorOf(c, floor);
      const up = (cells?: string[]) => (cells ?? []).map((s) => s.toUpperCase());
      f.add = [...new Set([...f.add.filter((s) => !up(remove).includes(s)), ...up(add)])];
      f.remove = [...new Set([...f.remove.filter((s) => !up(add).includes(s)), ...up(remove)])];
    });
  },
});

defineAction({
  name: 'stand_set',
  description: 'Set where the hero stands to use a thing (painting pixels, on walkable floor). Reruns derive to verify for that place.',
  input: z.object({ slug: Slug, place: z.string().min(1), thing: z.string().min(1), at: XY }),
  job: true,
  async run({ slug, place, thing, at }, ctx) {
    return fixPlace(ctx, slug, place, 'derive', `stand ${thing}`, (c) => {
      thingOf(c, thing).stand = at;
    });
  },
});

defineAction({
  name: 'repaint_region',
  description: 'Repaint one region of a place with Muse ("make the lantern brass, not glass"): only that region changes. Costs one Muse edit; '
    + 'reruns paint to verify for that place (masks and walking are measured again).',
  input: z.object({ slug: Slug, place: z.string().min(1), region: RectIn, fix: z.string().min(3) }),
  job: true,
  async run({ slug, place, region, fix }, ctx) {
    return fixPlace(ctx, slug, place, 'paint', 'repaint', (c) => {
      c.repaint.push({ region, fix });
    });
  },
});

defineAction({
  name: 'corrections_clear',
  description: 'Take back fixes of a place: all of them, or those of one thing or floor. Reruns that place from paint (repaints) or masks.',
  input: z.object({ slug: Slug, place: z.string().min(1), key: z.string().min(1).optional().describe('One thing or floor; leave out to clear every fix of the place.') }),
  job: true,
  async run({ slug, place, key }, ctx) {
    const had = readCorrections(path.join(ctx.root, slug, 'places', place));
    const repaints = !key && had.repaint.length > 0;
    return fixPlace(ctx, slug, place, repaints ? 'paint' : 'masks', `clear ${key ?? 'fixes'}`, (c) => {
      if (key) {
        delete c.things[key];
        delete c.floors[key];
      } else {
        c.things = {};
        c.floors = {};
        c.repaint = [];
      }
    });
  },
});
