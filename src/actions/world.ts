// Reading a world: what exists, what each place has got so far, what verify said.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Verdict } from '../scene/verify.ts';
import { Slug, World } from '../world/schema.ts';
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

export function worldSummary(root: string, slug: string) {
  const dir = path.join(root, slug);
  const parsed = World.safeParse(readJson(path.join(dir, 'world.json')));
  const build = readJson<{ steps?: Record<string, { at: string; seconds: number }> }>(path.join(dir, 'build.json'));
  const places = parsed.success ? parsed.data.places : [];
  const verdicts = places.map((p) => readJson<Verdict>(path.join(dir, 'places', p.key, 'verify.json')));
  const cover = places.map((p) => ['painting.png', 'blockin.png'].map((f) => `places/${p.key}/${f}`).find((f) => fs.existsSync(path.join(dir, f)))).find(Boolean);
  return {
    slug,
    title: parsed.success ? parsed.data.title : slug,
    pitch: parsed.success ? parsed.data.pitch : null,
    issue: parsed.success ? null : fs.existsSync(path.join(dir, 'world.json')) ? 'world.json does not parse' : 'no world.json yet',
    places: places.length,
    playable: verdicts.filter((v) => v?.ok).length,
    verified: verdicts.filter(Boolean).length,
    steps: Object.keys(build?.steps ?? {}),
    cover: cover ? { file: cover, v: stamp(path.join(dir, cover)) } : null,
    changed: stamp(dir),
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
    if (!fs.existsSync(dir)) throw new ActionError(404, `no world ${slug} yet`);
    const parsed = World.safeParse(readJson(path.join(dir, 'world.json')));
    const build = readJson<{ steps?: Record<string, unknown> }>(path.join(dir, 'build.json'));
    const places = (parsed.success ? parsed.data.places : []).map((p) => {
      const at = (f: string) => path.join(dir, 'places', p.key, f);
      const stages = Object.fromEntries(STAGES.map(([name, f]) => [name, stamp(at(f))]));
      const verdict = readJson<Verdict>(at('verify.json'));
      const image = ['painting.png', 'blockin.png'].find((f) => stages[f === 'painting.png' ? 'painting' : 'blockin']);
      return {
        key: p.key,
        shows: p.shows,
        things: p.things.map((t) => ({ key: t.key, role: t.role })),
        exits: p.exits,
        stages,
        image: image ? { file: `places/${p.key}/${image}`, v: stamp(at(image)) } : null,
        verdict: verdict && { ok: verdict.ok, errors: verdict.errors, flags: verdict.flags },
      };
    });
    return {
      ...worldSummary(ctx.root, slug),
      world: parsed.success ? { start: parsed.data.start, hero: parsed.data.hero, style: parsed.data.style } : null,
      placeDetail: places,
      build: build?.steps ?? {},
      calls: callCounts(dir),
      jobs: ctx.jobs.list(slug).slice(-10),
    };
  },
});
