// Reading a world: what exists, what each place has got so far, what verify said.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { withPlay } from '../scene/playbook.ts';
import { currentVerdict } from '../scene/status.ts';
import type { Verdict } from '../scene/verify.ts';
import { readCorrections } from '../scene/corrections.ts';
import { placeTrouble } from '../studio/trouble.ts';
import { withThingEdits, WorldFiles } from '../world/files.ts';
import { liveVoiceFailures } from '../sound/data.ts';
import { Slug, World } from '../world/schema.ts';
import { storyNeeds } from '../story/check.ts';
import { ActionError, defineAction } from './registry.ts';

const STAGES = [
  ['layout', 'layout.json'],
  ['blockin', 'blockin.png'],
  ['painting', 'painting.png'],
  ['masks', 'masks.json'],
  ['geometry', 'geometry.json'],
  ['backdrop', 'backdrop.png'],
  ['verify', 'verify.json'],
] as const;

/** What a place looks like after each step: Spark's plan (named; the bare block-in in worlds laid out before plans), Muse's first paint and the final one, SAM's masks, the depth map, the walk grid. */
const LAYERS = [
  ['blockin', 'plan.png', 'blockin.png'],
  ['first', 'painting-first.png'],
  ['painting', 'painting.png'],
  ['masks', 'masks/overlay.png'],
  ['depth', 'depth.png'],
  ['walk', 'walk.png'],
] as const;

function stamp(file: string): number | null {
  try {
    return Math.round(fs.statSync(file).mtimeMs);
  } catch {
    return null;
  }
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Calls the models answered (sent, not memo hits) per model, from memo/calls.jsonl. */
export function callCounts(dir: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const log = path.join(dir, 'memo', 'calls.jsonl');
  if (!fs.existsSync(log)) return counts;
  for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const call = JSON.parse(line) as { model: string; hit: boolean };
      if (!call.hit) counts[call.model] = (counts[call.model] ?? 0) + 1;
    } catch {}
  }
  return counts;
}

/** How long each build step usually takes here: the median over the worlds built so far, for a world that has no times of its own. */
// A first world on a new machine: the step times of a four-place build (2026-10-27), so its first job still says about how long.
const FIRST_BUILD: Record<string, number> = { world: 17, story: 47, layout: 30, paint: 66, masks: 66, plates: 45, icons: 21, derive: 161, backdrop: 48, weather: 21, reactions: 21, cast: 61, model: 179, sprites: 188, sound: 67, voices: 49, verify: 1 };

export function typicalSeconds(root: string): Record<string, number> {
  const seen: Record<string, number[]> = {};
  for (const slug of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const steps = readJson<{ steps?: Record<string, { seconds?: number }> }>(path.join(root, slug, 'build.json'))?.steps ?? {};
    for (const [step, s] of Object.entries(steps)) if (typeof s?.seconds === 'number') (seen[step] ??= []).push(s.seconds);
  }
  return { ...FIRST_BUILD, ...Object.fromEntries(Object.entries(seen).map(([step, all]) => [step, all.sort((a, b) => a - b)[Math.floor(all.length / 2)]])) };
}

export function worldSummary(root: string, slug: string) {
  const dir = path.join(root, slug);
  const parsed = World.safeParse(readJson(path.join(dir, 'world.json')));
  const build = readJson<{ steps?: Record<string, { at: string; seconds: number }> }>(path.join(dir, 'build.json'));
  const places = parsed.success ? withThingEdits(parsed.data, dir).places : [];
  const verdicts = places.map((p) => currentVerdict(dir, p.key, p));
  const cover = places.map((p) => ['painting.png', 'blockin.png'].map((f) => `places/${p.key}/${f}`).find((f) => fs.existsSync(path.join(dir, f)))).find(Boolean);
  return {
    slug,
    title: parsed.success ? parsed.data.title : slug,
    pitch: parsed.success ? parsed.data.pitch : null,
    issue: parsed.success ? null : fs.existsSync(path.join(dir, 'world.json')) ? 'world.json does not parse' : 'no world.json yet',
    places: places.length,
    playable: verdicts.filter((v, i) => v?.ok && !placeTrouble(dir, places[i].key)).length,
    verified: verdicts.filter(Boolean).length,
    steps: Object.keys(build?.steps ?? {}),
    cover: cover ? { file: cover, v: stamp(path.join(dir, cover)) } : null,
    changed: stamp(dir),
    // Children's drawings or recordings kept with it: a workshop world, which opens on them until it is built.
    workshop: fs.existsSync(path.join(dir, 'drawings')) || fs.existsSync(path.join(dir, 'told')),
  };
}

defineAction({
  name: 'world_list',
  reads: true,
  description: 'List the worlds in worlds/: title, places, how many are playable, which build steps ran.',
  input: z.object({}),
  async run(_, ctx) {
    if (!fs.existsSync(ctx.root)) return [];
    return fs.readdirSync(ctx.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && Slug.safeParse(d.name).success)
      .map((d) => worldSummary(ctx.root, d.name))
      .sort((a, b) => (b.changed ?? 0) - (a.changed ?? 0));
  },
});

defineAction({
  name: 'world_status',
  reads: true,
  description: 'One world in detail: per place which stages exist (layout, painting, masks, geometry, backdrop, verify), verify errors and flags, build steps, model calls sent.',
  input: z.object({ slug: Slug }),
  async run({ slug }, ctx) {
    const dir = path.join(ctx.root, slug);
    // A world being built for the first time has no folder for its first seconds, but it has its job.
    if (!fs.existsSync(dir) && !ctx.jobs.list(slug).length) throw new ActionError(404, `no world ${slug} yet`);
    const raw = World.safeParse(readJson(path.join(dir, 'world.json')));
    const parsed = raw.success ? { success: true as const, data: withThingEdits(raw.data, dir) } : raw;
    const build = readJson<{ steps?: Record<string, unknown> }>(path.join(dir, 'build.json'));
    const animation = readJson<Record<string, { face?: string | null; audio?: string[] }>>(path.join(dir, 'face-preparation.json'));
    const buildSteps = { ...build?.steps };
    if (animation) {
      const warnings = Object.entries(animation).flatMap(([key, state]) => [state.face, ...(state.audio ?? [])].filter(Boolean).map(reason => `${key}: ${reason}`));
      if (buildSteps.faces || warnings.length) buildSteps.faces = { ...(buildSteps.faces as object ?? {}), status: warnings.length ? 'incomplete' : 'complete', warnings };
    }
    const places = (parsed.success ? parsed.data.places : []).map((p) => {
      const at = (f: string) => path.join(dir, 'places', p.key, f);
      const stages = Object.fromEntries(STAGES.map(([name, f]) => [name, stamp(at(f))]));
      const verdict = currentVerdict(dir, p.key, p);
      const image = ['painting.png', 'blockin.png'].find((f) => stages[f === 'painting.png' ? 'painting' : 'blockin']);
      return {
        key: p.key,
        shows: p.shows,
        things: p.things.map((t) => ({ key: t.key, role: t.role })),
        exits: p.exits,
        stages,
        image: image ? { file: `places/${p.key}/${image}`, v: stamp(at(image)) } : null,
        // The pictures each step leaves, in build order: Studio stacks them as the place is built.
        layers: Object.fromEntries(LAYERS.map(([name, ...fs]) => [name, fs.find((f) => stamp(at(f)))]).filter(([, f]) => f).map(([name, f]) => [name, { file: `places/${p.key}/${f}`, v: stamp(at(f!)) }])),
        verdict: verdict && { ok: verdict.ok, errors: verdict.errors.map((e) => withPlay(e, verdict.flags)), flags: verdict.flags.map((f) => withPlay(f, verdict.flags)) },
        /** Why the place is not playable in one line, and the step place_fix rebuilds it from (null: the agent's). */
        trouble: placeTrouble(dir, p.key),
      };
    });
    return {
      ...worldSummary(ctx.root, slug),
      world: parsed.success ? { start: parsed.data.start, hero: parsed.data.hero, style: parsed.data.style } : null,
      placeDetail: places,
      build: buildSteps,
      typical: typicalSeconds(ctx.root),
      calls: callCounts(dir),
      jobs: ctx.jobs.list(slug).slice(-10),
      audioMisses: audioMisses(ctx.root, slug, dir),
    };
  },
});

/** Sounds and spoken lines the last run could not make: the game plays without them, Studio offers a retry. */
function audioMisses(root: string, slug: string, dir: string) {
  const sounds = readJson<{ failures?: Record<string, string> }>(path.join(dir, 'sound', 'sounds.json'))?.failures ?? {};
  // Only lines the story still says: a rewritten line's old failure is history.
  const lines = fs.existsSync(path.join(dir, 'world.json')) ? liveVoiceFailures(new WorldFiles(slug, root)) : [];
  return { sounds: Object.entries(sounds).map(([id, reason]) => ({ id, reason })), lines };
}

defineAction({
  name: 'place_status',
  reads: true,
  description: 'One place up close: each thing\'s kind, SAM phrase and how its mask was found (coarse ones need a look), each floor, '
    + 'the review pictures (masks/overlay.png, walk.png), the stand spots, the fixes made so far, and each error that keeps it from being playable '
    + 'with its playbook: where to look, the fix tools to try in order, and the costly last resort.',
  input: z.object({ slug: Slug, place: z.string().min(1) }),
  async run({ slug, place }, ctx) {
    const dir = path.join(ctx.root, slug, 'places', place);
    if (!new WorldFiles(slug, ctx.root).world().places.some((p) => p.key === place)) throw new ActionError(404, `${slug} has no place ${place}`);
    type Made = { kind: string; phrase: string; source: string; coarse: boolean; brushed?: boolean };
    const masks = readJson<{ things: Record<string, Made>; floors: Record<string, Omit<Made, 'kind' | 'phrase'>>; flagged: string[] }>(path.join(dir, 'masks.json'));
    const geometry = readJson<{ things: Array<{ key: string; role?: string; box: [number, number, number, number]; stand: [number, number] }>; start: [number, number] }>(path.join(dir, 'geometry.json'));
    const picture = (f: string) => (fs.existsSync(path.join(dir, f)) ? { file: `places/${place}/${f}`, v: stamp(path.join(dir, f)) } : null);
    // A step that broke for this place in the last build stands before verify's errors: verify did not see it.
    const report = readJson<{ places?: Array<{ place: string; ok: boolean; issues?: Verdict['errors'] }> }>(path.join(ctx.root, slug, 'build.json'))?.places?.find((r) => r.place === place);
    const verdict = currentVerdict(path.join(ctx.root, slug), place);
    // Whether thing_remove takes a thing: a prop the story does not use (exits, items and people are the story's).
    const raw = World.safeParse(readJson(path.join(ctx.root, slug, 'world.json')));
    const roles = new Map((raw.success ? withThingEdits(raw.data, path.join(ctx.root, slug)).places.find((p) => p.key === place)?.things ?? [] : []).map((t) => [t.key, t.role]));
    const storyText = fs.existsSync(path.join(ctx.root, slug, 'story.json')) ? fs.readFileSync(path.join(ctx.root, slug, 'story.json'), 'utf8') : '';
    const added = readCorrections(dir).added;
    const removable = (key: string) => {
      const role = roles.get(key);
      if (added[key]) return { role: 'prop', removable: true };
      if (role !== 'prop') return { role, removable: false, why: `${role === 'npc' ? 'a person' : `an ${role ?? 'unknown thing'}`} in the story: ask the agent to change the story` };
      if (storyText && storyNeeds(JSON.parse(storyText), place, key)) return { role, removable: false, why: 'the story uses it: ask the agent to change the story' };
      return { role, removable: true };
    };
    const broke = report?.issues?.filter((i) => i.code === 'STEP_FAILED') ?? [];
    const composition = readJson<{ ok: boolean; pending?: boolean; error?: string; attempts?: Array<{ issues: string[] }> }>(path.join(dir, 'painting-layout.json'));
    return {
      playable: broke.length === 0 && (verdict?.ok ?? null),
      errors: [...broke, ...(verdict?.errors ?? [])].map((e) => withPlay(e, verdict?.flags)),
      flags: verdict?.flags ?? [],
      place,
      paintingLayout: composition && { ok: composition.ok, pending: composition.pending ?? false, attempts: composition.attempts?.length ?? 0, issues: composition.attempts?.at(-1)?.issues ?? [], error: composition.error ?? null },
      pictures: { painting: picture('painting.png') ?? picture('blockin.png'), masks: picture('masks/overlay.png'), walk: picture('walk.png') },
      things: Object.entries(masks?.things ?? {}).map(([key, t]) => ({ key, ...t, stand: geometry?.things.find((g) => g.key === key)?.stand ?? null, ...removable(key) })),
      floors: Object.entries(masks?.floors ?? {}).map(([key, f]) => ({ key, ...f })),
      flagged: masks?.flagged ?? [],
      start: geometry?.start ?? null,
      npcs: (geometry?.things ?? []).filter((g) => g.role === 'npc').map((g) => ({ key: g.key, box: g.box, at: [Math.round((g.box[0] + g.box[2]) / 2), Math.round(g.box[3])] as [number, number] })),
      corrections: readCorrections(dir),
    };
  },
});

defineAction({
  name: 'agent_sessions',
  reads: true,
  description: 'The recorded conversations with the agent on a world (studio/sessions), newest first: when, which agent, the prompts, how long. Open one in the Studio with ?replay=<file>.',
  input: z.object({ slug: Slug }),
  async run({ slug }, ctx) {
    const dir = path.join(ctx.root, slug, 'studio', 'sessions');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((file) => {
      const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean).flatMap((l) => {
        try {
          return [JSON.parse(l) as { at: string; type: string; text?: string; agent?: string; turn?: { id: number } }];
        } catch {
          return [];
        }
      });
      const states = lines.filter((l) => l.type === 'state');
      return {
        file,
        started: lines[0]?.at ?? null,
        ended: lines.at(-1)?.at ?? null,
        agents: [...new Set(states.map((l) => l.agent).filter(Boolean))],
        prompts: lines.filter((l) => l.type === 'user').map((l) => String(l.text).slice(0, 120)),
        turns: new Set(states.map((l) => l.turn?.id)).size,
        replayable: states.length > 0,
      };
    }).sort((a, b) => String(b.started).localeCompare(String(a.started)));
  },
});

defineAction({
  name: 'world_delete',
  description: 'Delete a world: the person only, from the Studio\'s menu or the command line, never the agent. It is moved to worlds/.trash/<slug>-<time>, '
    + 'so it can be brought back by moving the folder back. Refused while a job runs in it.',
  input: z.object({ slug: Slug }),
  async run({ slug }, ctx) {
    if (ctx.by === 'agent') throw new ActionError(403, 'only the person deletes a world');
    const dir = path.join(ctx.root, slug);
    if (!fs.existsSync(dir)) throw new ActionError(404, `no world ${slug}`);
    const busy = ctx.jobs.busy(slug);
    if (busy) throw new ActionError(409, `${busy.label} is running in ${slug}: stop it first`);
    const trash = path.join(ctx.root, '.trash');
    fs.mkdirSync(trash, { recursive: true });
    const to = path.join(trash, `${slug}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.renameSync(dir, to);
    ctx.events.publish('world.deleted', { world: slug, by: ctx.by });
    return { deleted: slug, movedTo: path.relative(ctx.root, to), restore: `move ${path.relative(process.cwd(), to)} back to ${path.relative(process.cwd(), dir)}` };
  },
});
