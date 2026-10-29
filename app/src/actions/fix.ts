// Fixing a place: each fix is written to places/<place>/corrections.json, then the place is rebuilt
// from the step the fix feeds, so the next full build keeps it. The agent gets the same tools.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Corrections, readCorrections, RectIn, Stroke, writeCorrections } from '../scene/corrections.ts';
import { Layout } from '../scene/layout.ts';
import { KINDS, parseCell } from '../scene/locate.ts';
import { wordKeys } from '../scene/words.ts';
import { agentBlocked } from '../studio/locks.ts';
import { placeTrouble } from '../studio/trouble.ts';
import { WorldFiles } from '../world/files.ts';
import { Slug, World } from '../world/schema.ts';
import { storyNeeds } from '../story/check.ts';
import { ActionError, defineAction, type ActionContext } from './registry.ts';

const XY = z.tuple([z.number(), z.number()]);
const Cell = z.string().refine((c) => !!parseCell(c), 'a grid cell like C12: a letter per 60 px column from A, a number per 60 px row from 1');

/** Applies a change to a place's corrections and rebuilds that place from `from` to verify, as a job. */
async function fixPlace(ctx: ActionContext, slug: string, place: string, from: 'layout' | 'paint' | 'masks' | 'derive', label: string, change: (c: Corrections) => void, addedThing?: string) {
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
  const needs = { layout: null, paint: 'blockin.png', masks: 'painting.png', derive: 'masks.json' }[from];
  if (needs && !fs.existsSync(path.join(placeDir, needs))) throw new ActionError(404, `${slug}/${place} has no ${needs} yet: build it first`);
  return ctx.jobs.start(slug, ['build', slug, '--from', from, '--to', 'verify', '--place', place], `${label} · ${place}`, ctx.by, () => {
    // The job snapshots first, then changes its source. Queued fixes must not change a running build.
    fs.mkdirSync(placeDir, { recursive: true });
    const fixes = readCorrections(placeDir);
    change(fixes);
    writeCorrections(placeDir, Corrections.parse(fixes));
    fs.rmSync(path.join(placeDir, 'verify.json'), { force: true });
  }, addedThing ? { place, key: addedThing } : undefined);
}

const thingOf = (c: Corrections, key: string) => (c.things[key] ??= { strokes: [] });
const floorOf = (c: Corrections, key: string) => (c.floors[key] ??= { add: [], remove: [], strokes: [] });

defineAction({
  name: 'corrections_get',
  reads: true,
  description: 'The fixes the person (or you) made to a place so far: SAM phrases, boxes, kinds, brush strokes, floor cells, stand spots, repaints, the painter\'s wording.',
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
    + '(column letter from A at the left, row number from 1 at the top). The cells guide SAM; brush strokes (mask_brush) are painted over its mask after, '
    + 'so removing cells does not take back a stroke: corrections_clear or mask_brush erase does. Reruns masks to verify for that place.',
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
  name: 'npc_move',
  description: 'Move an NPC to stand elsewhere in a place: at is where its feet go (painting pixels, on walkable floor); it is sized for the depth there. '
    + 'Use it when an NPC covers a thing the player must click, or stands somewhere odd. No repaint: reruns derive to verify for that place.',
  input: z.object({ slug: Slug, place: z.string().min(1), npc: z.string().min(1), at: XY }),
  job: true,
  async run({ slug, place, npc, at }, ctx) {
    const world = new WorldFiles(slug, ctx.root).world();
    const thing = world.places.find((p) => p.key === place)?.things.find((t) => t.key === npc);
    if (thing?.role !== 'npc') throw new ActionError(404, `${place} has no NPC called ${npc}`);
    return fixPlace(ctx, slug, place, 'derive', `move ${npc}`, (c) => {
      thingOf(c, npc).at = at;
    });
  },
});

defineAction({
  name: 'hero_start_set',
  description: 'Set where the hero begins in a place (painting pixels, on walkable floor; the nearest roomy cell of the main floor is used): '
    + 'when the hero starts in front of an NPC or a thing and hides it, or somewhere odd. Kept across rebuilds. No repaint: reruns derive to verify for that place.',
  input: z.object({ slug: Slug, place: z.string().min(1), at: XY }),
  job: true,
  async run({ slug, place, at }, ctx) {
    return fixPlace(ctx, slug, place, 'derive', 'hero start', (c) => {
      c.start = at;
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

/** A prop the person took off a place's list, or one they added: the place's thing list as world.json and the edits make it. */
function thingsOf(dir: string, place: string) {
  const world = World.safeParse(JSON.parse(fs.readFileSync(path.join(dir, 'world.json'), 'utf8')));
  const p = world.success ? world.data.places.find((x) => x.key === place) : undefined;
  if (!p) throw new ActionError(404, `no place ${place}`);
  return p;
}

defineAction({
  name: 'thing_remove',
  description: 'Take a thing off a place\'s list when the person says it should not be a thing of its own (a prop only: an exit, an item or a person '
    + 'belongs to the story, change that with story_redo). paintOut false (default): it stays painted, just no longer a separate card one can '
    + 'walk behind or click; reruns masks to verify. paintOut true: Muse also paints it out of the picture (one Muse edit); reruns paint to verify. '
    + 'Kept in corrections.json across rebuilds; history_undo takes it back.',
  input: z.object({ slug: Slug, place: z.string().min(1), thing: z.string().min(1), paintOut: z.boolean().optional() }),
  job: true,
  async run({ slug, place, thing, paintOut }, ctx) {
    const dir = path.join(ctx.root, slug);
    const placeDir = path.join(dir, 'places', place);
    const listed = thingsOf(dir, place).things.find((t) => t.key === thing);
    const added = readCorrections(placeDir).added[thing];
    if (!listed && !added) throw new ActionError(404, `${place} has no thing ${thing}`);
    if (listed && listed.role !== 'prop') throw new ActionError(409, `${thing} is ${listed.role === 'npc' ? 'a person' : `an ${listed.role}`} in the story: change the story with story_redo to take it out`);
    const story = path.join(dir, 'story.json');
    if (listed && fs.existsSync(story) && storyNeeds(JSON.parse(fs.readFileSync(story, 'utf8')), place, thing)) throw new ActionError(409, `the story uses ${thing}: change the story with story_redo to take it out`);
    let region: [number, number, number, number] | undefined;
    if (paintOut) {
      const masks = path.join(placeDir, 'masks.json');
      const box = fs.existsSync(masks) ? (JSON.parse(fs.readFileSync(masks, 'utf8')) as { things?: Record<string, { box?: number[] }> }).things?.[thing]?.box : undefined;
      if (!box) throw new ActionError(409, `${thing} has no mask yet, so there is nothing to paint out: take it off with paintOut false`);
      const pad = 16;
      region = [Math.max(0, box[0] - pad), Math.max(0, box[1] - pad), Math.min(1200, box[2] + pad), Math.min(896, box[3] + pad)];
    }
    const looks = (listed?.looks ?? added?.looks ?? thing.replace(/-/g, ' ')).replace(/^(a|an|the)\s+/i, '');
    return fixPlace(ctx, slug, place, paintOut ? 'paint' : 'masks', `remove ${thing}`, (c) => {
      if (added) delete c.added[thing];
      else thingOf(c, thing).removed = true;
      if (region) c.repaint.push({ region, fix: `Paint out the ${looks}: continue what is behind it, add nothing new` });
    });
  },
});

defineAction({
  name: 'thing_add',
  description: 'Make something painted in a place a thing of its own (a prop: a card one walks behind and can look at), when the person says it '
    + 'is missing from the list: what it is in their words ("the red bench by the fountain"), and its kind if they say how it meets the floor. '
    + 'It must already be in the painting. Reruns masks to verify; kept in corrections.json across rebuilds.',
  input: z.object({
    slug: Slug,
    place: z.string().min(1),
    looks: z.string().min(3).max(200).describe('What it is, as painted, in a few words.'),
    kind: z.enum(KINDS).optional(),
  }),
  job: true,
  async run({ slug, place, looks, kind }, ctx) {
    const dir = path.join(ctx.root, slug);
    const p = thingsOf(dir, place);
    const fixes = readCorrections(path.join(dir, 'places', place));
    const pending = ctx.jobs.list(slug).flatMap((j) => (j.state === 'queued' || j.state === 'running') && j.addedThing?.place === place ? [j.addedThing.key] : []);
    const taken = new Set([...p.things.map((t) => t.key), ...Object.keys(fixes.added), ...pending]);
    if (taken.size >= 10) throw new ActionError(409, `${place} has ten things already: take one off first`);
    const base = looks.toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 4).join('-') || 'thing';
    const key = /^[a-z]/.test(base) ? base : `thing-${base}`;
    let unique = key;
    for (let n = 2; taken.has(unique); n++) unique = `${key}-${n}`;
    const job = await fixPlace(ctx, slug, place, 'masks', `add ${unique}`, (c) => {
      if (c.added[unique]) throw new ActionError(409, `${unique} was added while this job waited: add it again to choose a new key`);
      c.added[unique] = { looks };
      if (kind) thingOf(c, unique).kind = kind;
      if (c.things[unique]) delete c.things[unique].removed;
    }, unique);
    return { thing: unique, job };
  },
});

defineAction({
  name: 'layout_fix',
  description: 'Repair a place whose layout has not finished, even if its directory and painting do not exist. Save concrete layout guidance (camera, object sizes, floor access) and rebuild only that place through verify. Read place_status first. Existing painted scenes use the other fix tools.',
  input: z.object({ slug: Slug, place: Slug, guidance: z.string().min(10).max(4000) }),
  job: true,
  async run({ slug, place, guidance }, ctx) {
    const files = new WorldFiles(slug, ctx.root);
    if (!files.world().places.some((p) => p.key === place)) throw new ActionError(404, `${slug} has no place ${place}`);
    if (fs.existsSync(files.place(place, 'painting.png'))) throw new ActionError(409, `${place} already has a painting: use the existing place fix tools`);
    return fixPlace(ctx, slug, place, 'layout', 'repair layout', (c) => {
      if (fs.existsSync(files.place(place, 'painting.png'))) throw new ActionError(409, `${place} acquired a painting while this repair waited: use the existing place fix tools`);
      c.layout = { guidance };
    });
  },
});

defineAction({
  name: 'place_fix',
  description: 'The Fix it button of a place that failed or was never painted: rebuilds the place from the step it broke at (paint rewords by itself '
    + 'when the image safety filter refused it), or, when it was built through and verify still finds errors, hands it to the agent.',
  input: z.object({ slug: Slug, place: z.string().min(1) }),
  async run({ slug, place }, ctx) {
    const dir = path.join(ctx.root, slug);
    if (!new WorldFiles(slug, ctx.root).world().places.some((p) => p.key === place)) throw new ActionError(404, `${slug} has no place ${place}`);
    const trouble = placeTrouble(dir, place);
    if (!trouble) throw new ActionError(409, `${place} has nothing to fix: it is playable or not built yet`);
    if (trouble.from) {
      const blocked = agentBlocked(dir, ctx.by, place);
      if (blocked) throw new ActionError(423, blocked);
      const job = trouble.from === 'layout'
        ? await fixPlace(ctx, slug, place, 'layout', 'retry layout', () => {})
        : ctx.jobs.start(slug, ['build', slug, '--from', trouble.from, '--to', 'verify', '--place', place], `fix ${place} from ${trouble.from}`, ctx.by);
      return { did: 'rebuild', from: trouble.from, why: trouble.why, job };
    }
    // Built through and still not playable: the fix tools need judgement, which is the agent's (or the person's).
    if (ctx.by === 'agent') throw new ActionError(409, `${place} needs a fix tool: ${trouble.why}; follow place_status's playbook`);
    const prompt = `[Studio] The person pressed Fix it on ${place}, which is not playable:\n${trouble.errors.map((e) => `- ${e}`).join('\n')}\n`
      + 'Repair it as your brief says: place_status and place_view first, then the playbook\'s fix tools in order, at most three fixes, '
      + 'and ask me before the last resort. Then tell me in two sentences what you fixed and what is left for me.';
    ctx.events.publish('repair.ask', { world: slug, place, prompt });
    return { did: 'agent', why: trouble.why };
  },
});

defineAction({
  name: 'paint_words',
  description: 'Reword how a place is described to the painter: what the place shows, its mood, and the look of things and floors (one sentence each, '
    + 'used as it is). Use it when paint failed with content_policy_violation (the image safety filter refused a word such as "bare" or "hanging"), '
    + 'or when the painting keeps getting a thing wrong in kind. world.json and the story stay as they are. Repaints the place from paint to verify.',
  input: z.object({
    slug: Slug,
    place: z.string().min(1),
    shows: z.string().min(10).optional().describe('What the place shows, in place of world.json\'s.'),
    mood: z.string().min(2).optional(),
    looks: z.record(z.string(), z.string().min(10)).optional().describe('Thing or floor key to one sentence on how it looks.'),
  }),
  job: true,
  async run({ slug, place, shows, mood, looks }, ctx) {
    const world = new WorldFiles(slug, ctx.root).world();
    const p = world.places.find((x) => x.key === place);
    if (!p) throw new ActionError(404, `${slug} has no place ${place}`);
    if (!shows && !mood && !looks) throw new ActionError(400, 'give shows, mood or looks');
    const layoutFile = path.join(ctx.root, slug, 'places', place, 'layout.json');
    const floors = fs.existsSync(layoutFile) ? Layout.parse(JSON.parse(fs.readFileSync(layoutFile, 'utf8'))).floors : [];
    const keys = wordKeys(p, { floors });
    const unknown = Object.keys(looks ?? {}).filter((k) => !keys.includes(k));
    if (unknown.length) throw new ActionError(400, `${place} has no painted thing or floor ${unknown.join(', ')}: it has ${keys.join(', ')}`);
    return fixPlace(ctx, slug, place, 'paint', 'reword', (c) => {
      const had = c.words ?? { looks: {}, by: 'person' as const };
      c.words = { ...had, ...(shows && { shows }), ...(mood && { mood }), looks: { ...had.looks, ...looks }, by: 'person' };
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
    const repaints = !key ? had.repaint.length > 0 || !!had.words : !!had.words?.looks[key];
    const unfinishedLayout = !key && had.layout && !fs.existsSync(path.join(ctx.root, slug, 'places', place, 'painting.png'));
    return fixPlace(ctx, slug, place, unfinishedLayout ? 'layout' : repaints ? 'paint' : 'masks', `clear ${key ?? 'fixes'}`, (c) => {
      if (key) {
        delete c.things[key];
        delete c.floors[key];
        delete c.added[key];
        if (c.words) delete c.words.looks[key];
      } else {
        c.things = {};
        c.floors = {};
        c.added = {};
        c.repaint = [];
        delete c.words;
        delete c.layout;
      }
    });
  },
});
