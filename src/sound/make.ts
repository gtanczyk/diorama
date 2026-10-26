// Turns a sound plan into files: generates each take, checks it, makes loops seamless, cuts footsteps,
// levels everything, and writes sound/<id>.mp3 plus sound/sounds.json for the runtime.
import { z } from 'zod';
import type { Memo } from '../meta/memo.ts';
import { decode, encodeMp3, loopProblem, normalise, seamless, seconds, steps, trim, type Pcm } from './pcm.ts';
import { soundIds, type SoundPlan } from './plan.ts';
import { elevenKey, elevenMusic, musicgen, MUSICGEN_MODEL, soundEffect } from './sources.ts';

export const Kind = z.enum(['music', 'bed', 'loop', 'step', 'shot']);
export type Kind = z.infer<typeof Kind>;

export const SoundEntry = z.object({
  file: z.string(),
  kind: Kind,
  level: z.number().default(2),
  seconds: z.number(),
  /** Footsteps: [start, duration] of each single step inside the file. */
  slices: z.array(z.tuple([z.number(), z.number()])).optional(),
  source: z.string(),
  prompt: z.string(),
  flags: z.array(z.string()).default([]),
});
export const SoundManifest = z.object({ sounds: z.record(z.string(), SoundEntry) });
export type SoundEntry = z.infer<typeof SoundEntry>;
export type SoundManifest = z.infer<typeof SoundManifest>;

/** Loudness each kind is levelled to before the mixer's own gains, dBFS RMS. */
const TARGET_DB: Record<Kind, number> = { music: -20, bed: -24, loop: -22, step: -16, shot: -17 };
const LENGTH: Record<Exclude<Kind, 'shot'>, number> = { music: 30, bed: 20, loop: 10, step: 6 };
const STEADY = ', continuous and steady throughout, no single standout events, no silence, seamless loop';

export type Job = { id: string; kind: Kind; prompt: string; seconds: number; level: number };

export function jobsOf(plan: SoundPlan): Job[] {
  const jobs: Job[] = [{ id: soundIds.music(), kind: 'music', prompt: plan.music.prompt, seconds: LENGTH.music, level: 2 }];
  for (const [place, p] of Object.entries(plan.places)) {
    jobs.push({ id: soundIds.bed(place), kind: 'bed', prompt: p.bed, seconds: LENGTH.bed, level: 2 });
    for (const loop of p.loops) jobs.push({ id: soundIds.loop(place, loop.thing), kind: 'loop', prompt: loop.prompt, seconds: LENGTH.loop, level: loop.level });
  }
  for (const [surface, prompt] of Object.entries(plan.steps)) jobs.push({ id: soundIds.step(surface), kind: 'step', prompt, seconds: LENGTH.step, level: 2 });
  for (const shot of plan.shots) jobs.push({ id: soundIds.shot(shot.on), kind: 'shot', prompt: shot.prompt, seconds: shot.seconds, level: shot.level });
  return jobs;
}

type Made = { mp3: Buffer; entry: Omit<SoundEntry, 'file'> };

async function makeOne(memo: Memo, job: Job, music: { python?: string }): Promise<Made> {
  const flags: string[] = [];
  const entry = (pcm: Pcm, source: string, extra: Partial<SoundEntry> = {}): Made => ({
    mp3: encodeMp3(pcm, job.kind === 'step' || job.kind === 'shot' ? 160 : 128),
    entry: { kind: job.kind, level: job.level, seconds: Math.round(seconds(pcm) * 1000) / 1000, source, prompt: job.prompt, flags, ...extra },
  });

  if (job.kind === 'music') {
    // Meta's MusicGen when Python is set up for it; otherwise ElevenLabs music.
    const raw = music.python
      ? await musicgen(memo, job.id, job.prompt, job.seconds, music.python)
      : await elevenMusic(memo, job.id, job.prompt, job.seconds);
    const pcm = normalise(seamless(decode(raw), 3), TARGET_DB.music);
    return entry(pcm, music.python ? MUSICGEN_MODEL : 'elevenlabs-music');
  }

  if (job.kind === 'bed' || job.kind === 'loop') {
    // A loop request can still come back as one event; ask once more, more firmly, then keep the better take.
    let pcm = decode(await soundEffect(memo, { label: job.id, prompt: job.prompt, seconds: job.seconds, loop: true }));
    const problem = loopProblem(pcm);
    if (problem) {
      const retry = decode(await soundEffect(memo, { label: `${job.id}-2`, prompt: job.prompt + STEADY, seconds: job.seconds, loop: true, take: 2 }));
      const again = loopProblem(retry);
      if (!again) pcm = retry;
      else flags.push(`does not loop well: ${again}`);
      flags.push(`first take ${problem}${again ? '' : ', second take used'}`);
    }
    return entry(normalise(seamless(pcm, job.kind === 'bed' ? 1.5 : 0.8), TARGET_DB[job.kind]), 'elevenlabs');
  }

  if (job.kind === 'step') {
    let pcm = normalise(decode(await soundEffect(memo, { label: job.id, prompt: job.prompt, seconds: job.seconds, loop: false })), TARGET_DB.step);
    let slices = steps(pcm);
    if (slices.length < 3) {
      const retry = normalise(decode(await soundEffect(memo, { label: `${job.id}-2`, prompt: `${job.prompt}, clearly separated single footsteps with short pauses`, seconds: job.seconds, loop: false, take: 2 })), TARGET_DB.step);
      const again = steps(retry);
      flags.push(`first take had ${slices.length} separate steps${again.length > slices.length ? ', second take used' : ''}`);
      if (again.length > slices.length) [pcm, slices] = [retry, again];
    }
    if (slices.length < 2) flags.push(`only ${slices.length} footstep(s) found`);
    return entry(pcm, 'elevenlabs', { slices });
  }

  const pcm = normalise(trim(decode(await soundEffect(memo, { label: job.id, prompt: job.prompt, seconds: job.seconds, loop: false }))), TARGET_DB.shot);
  return entry(pcm, 'elevenlabs');
}

/** Runs `jobs` a few at a time. */
async function pool<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await run(items[i]);
    }
  }));
  return out;
}

export async function makeSounds(memo: Memo, plan: SoundPlan, write: (id: string, mp3: Buffer) => string, opts: { python?: string; only?: Kind[]; log?: (line: string) => void }): Promise<SoundManifest> {
  if (!elevenKey()) throw new Error('no ElevenLabs key: set ELEVENLABS_API_KEY to generate sounds (the plan is written without it)');
  const jobs = jobsOf(plan).filter((j) => !opts.only || opts.only.includes(j.kind));
  const sounds: Record<string, SoundEntry> = {};
  await pool(jobs, 3, async (job) => {
    try {
      const made = await makeOne(memo, job, { python: opts.python });
      sounds[job.id] = { file: write(job.id, made.mp3), ...made.entry };
      opts.log?.(`  ${job.id.padEnd(34)} ${made.entry.seconds.toFixed(1).padStart(5)} s${made.entry.slices ? `, ${made.entry.slices.length} steps` : ''}${made.entry.flags.length ? `  flag: ${made.entry.flags.join('; ')}` : ''}`);
    } catch (error) {
      opts.log?.(`  ${job.id.padEnd(34)} FAILED, stays silent: ${error instanceof Error ? error.message : error}`);
    }
  });
  return { sounds };
}
