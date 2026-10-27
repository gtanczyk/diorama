// Building: the whole pipeline or one step, as a job; plus the job list and cancel.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { STEPS } from '../commands/build.ts';
import { Slug } from '../world/schema.ts';
import { agentBlocked } from '../studio/locks.ts';
import { ActionError, defineAction } from './registry.ts';

const Step = z.enum(STEPS);

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
    const start = from ?? (fresh ? 'world' : STEPS.find((s) => s !== 'world' && !(s in done)) ?? 'verify');
    const args = ['build', slug, ...(idea ? [idea] : []), '--from', start, ...(to ? ['--to', to] : []), ...(places ? ['--places', String(places)] : [])];
    return ctx.jobs.start(slug, args, `build ${start} > ${to ?? STEPS[STEPS.length - 1]}`, ctx.by);
  },
});

defineAction({
  name: 'run_step',
  description: `Run one build step on a world (${STEPS.join(', ')}). Runs as a job.`,
  input: z.object({ slug: Slug, step: Step }),
  job: true,
  async run({ slug, step }, ctx) {
    if (step === 'world') throw new Error('the world step makes a new world: use world_build with an idea');
    const blocked = agentBlocked(path.join(ctx.root, slug), ctx.by);
    if (blocked) throw new ActionError(423, blocked);
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
  name: 'job_wait',
  reads: true,
  description: 'Wait for a job to end (or up to timeoutSeconds, default 120) and return it with its last output lines and the step it reached.',
  input: z.object({ id: z.string().min(1), timeoutSeconds: z.number().int().min(1).max(600).optional() }),
  async run({ id, timeoutSeconds }, ctx) {
    return ctx.jobs.wait(id, (timeoutSeconds ?? 120) * 1000);
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
  description: 'Run a failed or stopped job again; a build picks up at the step it failed on.',
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
    // Steps before the failed one are done; start where it broke.
    if (args[0] === 'build' && from >= 0 && job.step && (STEPS as readonly string[]).includes(job.step)) args[from + 1] = job.step;
    return ctx.jobs.start(job.world, args, job.label, ctx.by);
  },
});
