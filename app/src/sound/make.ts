// Turns a sound plan into files: generates each take, checks it, makes loops seamless, cuts footsteps,
// levels everything, and writes sound/<id>.mp3 plus sound/sounds.json for the runtime.
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { inputHash, type Memo } from '../meta/memo.ts';
import { sharedDir, soundQuality } from './cost.ts';
import { audioProblem, decode, encodeMp3, hiss, loopProblem, tonalShare, normalise, seamless, seconds, steps, trim, type Pcm } from './pcm.ts';
import { soundIds, type SoundPlan } from './plan.ts';
import { elevenKey, elevenMusic, forgetEffect, musicgen, MUSICGEN_MODEL, soundEffect, type EffectAsk } from './sources.ts';
import type { SoundFixes } from './fixes.ts';

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
  /** Made in draft or final quality; sounds made before qualities existed were full length. */
  quality: z.enum(['draft', 'final']).default('final'),
  /** How ambience was mixed: below MIX it is made again (from the memo, at no cost) with the current levels and hiss check. */
  mix: z.number().optional(),
  validation: z.number().optional(),
});
export const SoundManifest = z.object({ sounds: z.record(z.string(), SoundEntry), failures: z.record(z.string(), z.string()).default({}) });
export type SoundEntry = z.infer<typeof SoundEntry>;
export type SoundManifest = z.infer<typeof SoundManifest>;

/** Loudness each kind is levelled to before the mixer's own gains, dBFS RMS. */
// Ambience sits well under the music: at -24 a bed of wind and leaves was a constant hiss over the whole game.
const TARGET_DB: Record<Kind, number> = { music: -20, bed: -31, loop: -28, step: -16, shot: -17 };
/** Ambience made with the levels and the hiss check above; older beds and loops are made again. */
export const MIX = 3;
export const AUDIO_VALIDATION = 1;
/** Above this a bed or loop is mostly hiss (energy of the sample-to-sample change over the energy: white noise is 2, music 0.06). */
export const HISS = 0.4;
const NO_HISS = '. Not wind, not rustling, no hiss or air noise: soft distant life and warm low tones';
/** Mostly hiss: high-frequency energy that is noise. Crickets, birdsong and other tones are not hiss, however bright. */
export const hissy = (pcm: Pcm) => hiss(pcm) > HISS && tonalShare(pcm) < 0.3;
/**
 * What the next take asks for, from what was wrong with the last one: only a hissy take is asked for no hiss. Asking
 * a quiet one to be "gentle and quiet" (or even "clearly audible": the level does not follow the words) does not help.
 */
export function retakePrompt(prompt: string, take: number, problem: string): string {
  if (take === 1) return prompt;
  return prompt + STEADY + (/hiss/.test(problem) ? NO_HISS : '');
}
const LENGTH: Record<Exclude<Kind, 'shot'>, number> = { music: 30, bed: 20, loop: 10, step: 6 };
/** Draft lengths: ElevenLabs bills effects by the second, and a seamless loop repeats fine at half the length. */
const DRAFT: Record<Exclude<Kind, 'shot'>, number> = { music: 30, bed: 10, loop: 6, step: 4 };
const length = (kind: Exclude<Kind, 'shot'>) => (soundQuality() === 'final' ? LENGTH : DRAFT)[kind];

/** Sounds that do not belong to one world: footsteps per surface and the UI one-shots. Drafts reuse them across worlds. */
const GENERIC = /^(step-.+|shot-(take|click|talk|ending))$/;
const libraryFile = (id: string, prompt: string, ext: string) => sharedDir('library', `${id}-${inputHash(prompt)}.${ext}`);

function fromLibrary(job: Job): Made | undefined {
  const { id, prompt, kind, level } = job;
  if (!GENERIC.test(id)) return undefined;
  try {
    const entry = JSON.parse(fs.readFileSync(libraryFile(id, prompt, 'json'), 'utf8')) as Made['entry'];
    if (entry.prompt !== prompt || entry.kind !== kind || entry.validation !== AUDIO_VALIDATION
      || (soundQuality() === 'final' && entry.quality !== 'final')) return undefined;
    return { mp3: fs.readFileSync(libraryFile(id, prompt, 'mp3')), entry: { ...entry, level, source: `library (${entry.source})` } };
  } catch { return undefined; }
}

/** A world's own generic sound joins the library too, so the next world in draft reuses it. */
export function seedLibrary(id: string, entry: SoundEntry, mp3: Buffer) {
  if (entry.validation === AUDIO_VALIDATION) toLibrary(id, { mp3, entry });
}

function toLibrary(id: string, made: Made) {
  if (!GENERIC.test(id) || made.entry.flags.length || made.entry.source.startsWith('library')) return;
  fs.mkdirSync(path.dirname(libraryFile(id, made.entry.prompt, 'mp3')), { recursive: true });
  fs.writeFileSync(libraryFile(id, made.entry.prompt, 'mp3'), made.mp3);
  fs.writeFileSync(libraryFile(id, made.entry.prompt, 'json'), JSON.stringify(made.entry));
}
const STEADY = ', continuous and steady throughout, no single standout events, no silence, seamless loop';

/** `retake`: rounds of takes asked for again (sound_redo); each round asks for new takes instead of replaying cached ones. */
export type Job = { id: string; kind: Kind; prompt: string; seconds: number; level: number; retake?: number };

/** The sounds a plan asks for, with the person's hints (sound/fixes.json) added to their prompts. */
export function jobsOf(plan: SoundPlan, fixes: SoundFixes = {}): Job[] {
  return planJobs(plan).map((j) => {
    const fix = fixes[j.id];
    return fix ? { ...j, ...(fix.hint && { prompt: `${j.prompt}. ${fix.hint}` }), ...(fix.take && { retake: fix.take }) } : j;
  });
}

function planJobs(plan: SoundPlan): Job[] {
  const jobs: Job[] = [{ id: soundIds.music(), kind: 'music', prompt: plan.music.prompt, seconds: length('music'), level: 2 }];
  for (const [place, p] of Object.entries(plan.places)) {
    jobs.push({ id: soundIds.bed(place), kind: 'bed', prompt: p.bed, seconds: length('bed'), level: 2 });
    for (const loop of p.loops) jobs.push({ id: soundIds.loop(place, loop.thing), kind: 'loop', prompt: loop.prompt, seconds: length('loop'), level: loop.level });
  }
  for (const [surface, prompt] of Object.entries(plan.steps)) jobs.push({ id: soundIds.step(surface), kind: 'step', prompt, seconds: length('step'), level: 2 });
  for (const shot of plan.shots) jobs.push({ id: soundIds.shot(shot.on), kind: 'shot', prompt: shot.prompt, seconds: shot.seconds, level: shot.level });
  return jobs;
}

type Made = { mp3: Buffer; entry: Omit<SoundEntry, 'file'> };

async function makeOne(memo: Memo, job: Job, music: { python?: string }): Promise<Made> {
  const flags: string[] = [];
  const entry = (pcm: Pcm, source: string, extra: Partial<SoundEntry> = {}): Made => ({
    mp3: encodeMp3(pcm, job.kind === 'step' || job.kind === 'shot' ? 160 : 128),
    entry: { kind: job.kind, level: job.level, seconds: Math.round(seconds(pcm) * 1000) / 1000, source, prompt: job.prompt, flags, quality: soundQuality(), validation: AUDIO_VALIDATION, ...extra },
  });

  if (job.kind === 'music') {
    // Meta's MusicGen when Python is set up for it; otherwise ElevenLabs music.
    const raw = music.python
      ? await musicgen(memo, job.id, job.prompt, job.seconds, music.python)
      : await elevenMusic(memo, job.id, job.prompt, job.seconds);
    const decoded = decode(raw);
    const problem = audioProblem(decoded);
    if (problem) throw new Error(`music rejected: ${problem}`);
    const pcm = normalise(seamless(decoded, 3), TARGET_DB.music);
    return entry(pcm, music.python ? MUSICGEN_MODEL : 'elevenlabs-music');
  }

  if (job.kind === 'bed' || job.kind === 'loop') {
    let problem = '';
    const round = 3 * (job.retake ?? 0);
    for (let take = 1; take <= 3; take++) {
      const prompt = retakePrompt(job.prompt, take, problem);
      const ask: EffectAsk = { label: `${job.id}-${round + take}`, prompt, seconds: job.seconds, loop: true, take: round + take };
      const pcm = decode(await soundEffect(memo, ask));
      problem = audioProblem(pcm) ?? loopProblem(pcm, { beats: job.kind === 'loop' }) ?? (hissy(pcm) ? 'mostly hiss' : '');
      if (problem) forgetEffect(memo, ask);
      if (!problem) return entry(normalise(seamless(pcm, job.kind === 'bed' ? 1.5 : 0.8), TARGET_DB[job.kind]), 'elevenlabs', { mix: MIX });
    }
    throw new Error(`loop rejected after 3 takes: ${problem}`);
  }

  if (job.kind === 'step') {
    const round = 2 * (job.retake ?? 0);
    let pcm = decode(await soundEffect(memo, { label: job.id, prompt: job.prompt, seconds: job.seconds, loop: false, ...(round ? { take: round + 1 } : {}) }));
    let slices = audioProblem(pcm) ? [] : steps(pcm);
    if (slices.length < 3) {
      const retry = decode(await soundEffect(memo, { label: `${job.id}-${round + 2}`, prompt: `${job.prompt}, clearly separated single footsteps with short pauses`, seconds: job.seconds, loop: false, take: round + 2 }));
      const again = audioProblem(retry) ? [] : steps(retry);
      flags.push(`first take had ${slices.length} separate steps${again.length > slices.length ? ', second take used' : ''}`);
      if (again.length > slices.length) [pcm, slices] = [retry, again];
    }
    if (slices.length < 2) throw new Error(`footsteps rejected: only ${slices.length} separate steps`);
    const problem = audioProblem(pcm);
    if (problem) throw new Error(`footsteps rejected: ${problem}`);
    return entry(normalise(pcm, TARGET_DB.step), 'elevenlabs', { slices });
  }

  let problem = '';
  for (let take = 1; take <= 2; take++) {
    const t = 2 * (job.retake ?? 0) + take;
    const ask: EffectAsk = { label: `${job.id}-${t}`, prompt: job.prompt, seconds: job.seconds, loop: false, take: t };
    const pcm = trim(decode(await soundEffect(memo, ask)));
    problem = audioProblem(pcm) ?? '';
    if (problem) forgetEffect(memo, ask);
    if (!problem) return entry(normalise(pcm, TARGET_DB.shot), 'elevenlabs');
  }
  throw new Error(`effect rejected: ${problem}`);
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

/**
 * Makes the plan's sounds. A sound the world already has (same id, kind and prompt, file present, at least this
 * quality) is kept as it is: a rebuild pays only for what the plan changed.
 */
export async function makeSounds(memo: Memo, plan: SoundPlan, write: (id: string, mp3: Buffer) => string, opts: { python?: string; only?: Kind[]; ids?: string[]; fixes?: SoundFixes; log?: (line: string) => void; have?: (entry: SoundEntry) => boolean; old?: Record<string, SoundEntry>; failedBefore?: Record<string, string> }): Promise<SoundManifest> {
  if (!elevenKey()) throw new Error('no ElevenLabs key: set ELEVENLABS_API_KEY to generate sounds (the plan is written without it)');
  const sounds: Record<string, SoundEntry> = {};
  const failures: Record<string, string> = {};
  const jobs = jobsOf(plan, opts.fixes).filter((j) => (!opts.only || opts.only.includes(j.kind)) && (!opts.ids || opts.ids.includes(j.id))).filter((j) => {
    const old = opts.old?.[j.id];
    // A sound asked for by id (sound_redo) is made again even when its prompt did not change.
    const keep = !opts.ids && old && old.validation === AUDIO_VALIDATION && old.kind === j.kind && old.prompt === j.prompt && (old.quality === 'final' || soundQuality() === 'draft') && ((j.kind !== 'bed' && j.kind !== 'loop') || (old.mix ?? 0) >= MIX) && opts.have?.(old);
    if (keep) sounds[j.id] = old;
    return !keep;
  });
  if (Object.keys(sounds).length) opts.log?.(`  ${Object.keys(sounds).length} sounds kept from the last run (prompt unchanged)`);
  // Rejected last time: say so, since this run asks for new takes (the rejected ones were forgotten) and pays again.
  const again = jobs.filter((j) => opts.failedBefore?.[j.id]);
  if (again.length) opts.log?.(`  ${again.length} sounds rejected last time, asked for new takes: ${again.map((j) => `${j.id} (${opts.failedBefore![j.id]})`).join('; ')}`);
  await pool(jobs, 3, async (job) => {
    try {
      const made = fromLibrary(job) ?? (await makeOne(memo, job, { python: opts.python }));
      toLibrary(job.id, made);
      sounds[job.id] = { file: write(job.id, made.mp3), ...made.entry };
      opts.log?.(`  ${job.id.padEnd(34)} ${made.entry.seconds.toFixed(1).padStart(5)} s${made.entry.slices ? `, ${made.entry.slices.length} steps` : ''}${made.entry.flags.length ? `  flag: ${made.entry.flags.join('; ')}` : ''}`);
    } catch (error) {
      failures[job.id] = error instanceof Error ? error.message : String(error);
      opts.log?.(`  ${job.id.padEnd(34)} FAILED, stays silent: ${error instanceof Error ? error.message : error}`);
    }
  });
  return { sounds, failures };
}
