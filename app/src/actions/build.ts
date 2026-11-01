import { WorldFiles } from '../world/files.ts';
import { placesFirst } from './faces.ts';
// Building: the whole pipeline or one step, as a job; plus the job list and cancel.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { STEPS } from '../commands/build.ts';
import { Slug } from '../world/schema.ts';
import { agentBlocked } from '../studio/locks.ts';
import { ActionError, defineAction } from './registry.ts';

const Step = z.enum(STEPS);

/** Places the last build set aside at a step (build.json `places[].from`), optionally only one. */
export function brokenPlaces(dir: string, only?: string): Array<{ place: string; from: string }> {
  const log = path.join(dir, 'build.json');
  if (!fs.existsSync(log)) return [];
  const places = (JSON.parse(fs.readFileSync(log, 'utf8')) as { places?: Array<{ place: string; from?: string }> }).places ?? [];
  return places.filter((r): r is { place: string; from: string } => !!r.from && (!only || r.place === only));
}

defineAction({
  name: 'world_build',
  description: 'Build a world: every step from world to verify, or a range. A new world needs an idea. Runs as a job; follow it with world_status or the live feed.',
  input: z.object({
    slug: Slug,
    idea: z.string().min(10).optional().describe('What the world is about; needed when the build starts at the world step.'),
    from: Step.optional(),
    to: Step.optional(),
    places: z.number().int().min(1).max(8).optional(),
  }),
  job: true,
  async run({ slug, idea, from, to, places }, ctx) {
    const blocked = agentBlocked(path.join(ctx.root, slug), ctx.by);
    if (blocked) throw new ActionError(423, blocked);
    const fresh = !fs.existsSync(path.join(ctx.root, slug, 'world.json'));
    if (fresh && !idea && (!from || from === 'world')) throw new Error(`${slug} is a new world: give it an idea`);
    // An existing world picks up at the first step it has not finished.
    const log = path.join(ctx.root, slug, 'build.json');
    const done = !fresh && fs.existsSync(log) ? (JSON.parse(fs.readFileSync(log, 'utf8')) as { steps?: object }).steps ?? {} : {};
    const unfinished = fresh ? 'world' : STEPS.find((s) => s !== 'world' && !(s in done)) ?? 'verify';
    const broken = brokenPlaces(path.join(ctx.root, slug)).map((p) => p.from).filter((s): s is typeof STEPS[number] => (STEPS as readonly string[]).includes(s));
    const start = from ?? [unfinished, ...broken].sort((a, b) => STEPS.indexOf(a) - STEPS.indexOf(b))[0];
    const args = ['build', slug, ...(idea ? [idea] : []), '--from', start, ...(to ? ['--to', to] : []), ...(places ? ['--places', String(places)] : [])];
    return ctx.jobs.start(slug, args, `build ${start} > ${to ?? STEPS[STEPS.length - 1]}`, ctx.by);
  },
});

defineAction({
  name: 'run_step',
  description: `Run one build step on a world (${STEPS.join(', ')}). Runs as a job. With place: that place only, from the step through verify.`,
  input: z.object({ slug: Slug, step: Step, place: Slug.optional().describe('Only this place: rebuilt from the step through verify') }),
  job: true,
  async run({ slug, step, place }, ctx) {
    if (step === 'world') throw new Error('the world step makes a new world: use world_build with an idea');
    const blocked = agentBlocked(path.join(ctx.root, slug), ctx.by);
    if (blocked) throw new ActionError(423, blocked);
    if (step === 'faces') { const later = placesFirst(new WorldFiles(slug, ctx.root), slug, ctx); if (later) throw new ActionError(409, later); }
    if (place) return ctx.jobs.start(slug, ['build', slug, '--from', step, '--to', 'verify', '--place', place], `${step} · ${place}`, ctx.by);
    return ctx.jobs.start(slug, ['build', slug, '--from', step, '--to', step], step, ctx.by);
  },
});

defineAction({
  name: 'job_list',
  reads: true,
  description: 'Jobs this studio ran or queued, newest last, optionally for one world.',
  input: z.object({ slug: Slug.optional() }),
  async run({ slug }, ctx) {
    return ctx.jobs.list(slug);
  },
});

defineAction({
  name: 'job_inspect',
  reads: true,
  description: 'Inspect a job without waiting: elapsed and quiet time, timestamped recent logs and failures, current locally observed model/API operations and their duration, and voice/sound item counts. These describe the Studio process, not the remote provider internals; silence alone does not prove a hang. Use this when a job appears slow, and before deciding what to do. A staged extension is not in the game until it succeeds.',
  input: z.object({ id: z.string().min(1), limit: z.number().int().min(1).max(100).optional() }),
  async run({ id, limit }, ctx) {
    if (!ctx.jobs.get(id)) throw new ActionError(404, `no job ${id}`);
    return ctx.jobs.inspect(id, limit ?? 40);
  },
});

defineAction({
  name: 'job_wait',
  reads: true,
  description: 'Wait for a job to end (or up to timeoutSeconds, default 120) and return its state plus recent activity, locally observed operations and progress counts. A return with state running means it is still running. job_inspect shows more activity without waiting.',
  input: z.object({ id: z.string().min(1), timeoutSeconds: z.number().int().min(1).max(600).optional() }),
  async run({ id, timeoutSeconds }, ctx) {
    const job = await ctx.jobs.wait(id, (timeoutSeconds ?? 120) * 1000);
    return { ...job, telemetry: ctx.jobs.inspect(id, 12) };
  },
});

defineAction({
  name: 'job_cancel',
  description: 'Stop a running or queued job.',
  input: z.object({ id: z.string().min(1) }),
  async run({ id }, ctx) {
    return ctx.jobs.cancel(id);
  },
});

defineAction({
  name: 'job_retry',
  description: 'Run a failed or stopped job again; a build picks up at the step it failed on, or earlier at the step where a place was set aside.',
  input: z.object({ id: z.string().min(1) }),
  job: true,
  async run({ id }, ctx) {
    const job = ctx.jobs.get(id);
    if (!job) throw new ActionError(404, `no job ${id}`);
    if (job.state === 'running' || job.state === 'queued') throw new ActionError(409, `${job.label} is still ${job.state}`);
    const args = [...job.args];
    const place = args.includes('--place') ? args[args.indexOf('--place') + 1] : undefined;
    const blocked = agentBlocked(path.join(ctx.root, job.world), ctx.by, place);
    if (blocked) throw new ActionError(423, blocked);
    const from = args.indexOf('--from');
    // Steps before the failed one are done; start where it broke. A place set aside earlier in the build (its paint
    // refused, say) broke at its own step while the others went on: start at the earliest such step, or the retry
    // runs only the last step, which skips that place again.
    if (args[0] === 'build' && from >= 0 && job.step && (STEPS as readonly string[]).includes(job.step)) {
      const steps = STEPS as readonly string[];
      const broke = brokenPlaces(path.join(ctx.root, job.world), place).map((r) => r.from).filter((s) => steps.includes(s));
      args[from + 1] = [job.step, ...broke].sort((a, b) => steps.indexOf(a) - steps.indexOf(b))[0];
    }
    return ctx.jobs.retry(job.id, args, ctx.by);
  },
});

defineAction({
  name: 'playthrough',
  description: 'Let the bot play the world in a browser along the story\'s routes and check each ending is reached; says where it got stuck. Runs as a job.',
  input: z.object({ slug: Slug, ending: z.string().min(1).optional().describe('One ending; leave out for all of them.') }),
  job: true,
  async run({ slug, ending }, ctx) {
    if (!fs.existsSync(path.join(ctx.root, slug, 'story.json'))) throw new ActionError(404, `${slug} has no story yet: build it to the story step first`);
    return ctx.jobs.start(slug, ['playthrough', slug, ...(ending ? [ending] : [])], `playthrough${ending ? ` ${ending}` : ''}`, ctx.by);
  },
});
