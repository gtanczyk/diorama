// Building: the whole pipeline or one step, as a job; plus the job list and cancel.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { STEPS } from '../commands/build.ts';
import { Slug } from '../world/schema.ts';
import { defineAction } from './registry.ts';

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
