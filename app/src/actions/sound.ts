// The world's sounds one by one (ambience beds, loops, footsteps, one-shots, music): what each is asked for, whether
// it was made or rejected and why, and a redo for a single sound with a hint, kept in sound/fixes.json.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { jobsOf, SoundManifest } from '../sound/make.ts';
import { readSoundFixes, SoundFixes, soundFixesFile } from '../sound/fixes.ts';
import { SoundPlan } from '../sound/plan.ts';
import { agentBlocked } from '../studio/locks.ts';
import { WorldFiles } from '../world/files.ts';
import { Slug } from '../world/schema.ts';
import { ActionError, defineAction } from './registry.ts';

function soundFiles(slug: string, root: string) {
  const files = new WorldFiles(slug, root);
  if (!fs.existsSync(files.path('sound.json'))) throw new ActionError(404, `${slug} has no sound plan yet: run_step sound`);
  const plan = SoundPlan.parse(files.readJson(files.path('sound.json')));
  const made = fs.existsSync(files.path('sound', 'sounds.json')) ? SoundManifest.parse(files.readJson(files.path('sound', 'sounds.json'))) : { sounds: {}, failures: {} };
  return { files, plan, made };
}

defineAction({
  name: 'sound_status',
  reads: true,
  description: 'Every sound of a world (music, each place\'s ambience bed, loops of things, footsteps per surface, one-shots): the prompt it is asked for '
    + '(with the person\'s hint), whether it was made (file, seconds, flags) or rejected and why (rejected ones stay silent in the game), and the hint kept for it. '
    + 'Free. Use it before sound_redo.',
  input: z.object({ slug: Slug }),
  async run({ slug }, ctx) {
    const { files, plan, made } = soundFiles(slug, ctx.root);
    const fixes = readSoundFixes(files);
    return jobsOf(plan, fixes).map((j) => {
      const m = made.sounds[j.id];
      const current = m && m.prompt === j.prompt && fs.existsSync(files.path(m.file));
      return {
        id: j.id, kind: j.kind, prompt: j.prompt,
        state: current ? 'made' : made.failures[j.id] ? 'rejected' : m ? 'outdated' : 'not made',
        ...(current && { file: m.file, seconds: m.seconds, flags: m.flags }),
        ...(made.failures[j.id] && { rejected: made.failures[j.id] }),
        fix: fixes[j.id] ?? null,
      };
    });
  },
});

defineAction({
  name: 'sound_redo',
  description: 'Make one or more sounds again (ids from sound_status), e.g. an ambience rejected as "mostly hiss" or "nearly silent", or one the person says sounds wrong. '
    + 'hint (English, a few words: "a clear ticking clock and soft room tone, audible") is added to its prompt and kept across rebuilds and new sound plans; '
    + 'without a hint it simply asks ElevenLabs for new takes. Only these sounds are paid for (up to 3 takes each). Runs as a job; then play_reload.',
  input: z.object({ slug: Slug, ids: z.array(z.string().min(1)).min(1), hint: z.string().min(3).optional() }),
  job: true,
  async run({ slug, ids, hint }, ctx) {
    const { files, plan } = soundFiles(slug, ctx.root);
    const known = new Set(jobsOf(plan).map((j) => j.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) throw new ActionError(404, `${slug} has no sound ${unknown.join(', ')}: see sound_status`);
    const blocked = agentBlocked(files.dir, ctx.by);
    if (blocked) throw new ActionError(423, blocked);
    const prepare = () => {
      const fixes = readSoundFixes(files);
      for (const id of ids) {
        const fix = (fixes[id] ??= {});
        if (hint) fix.hint = hint;
        // A new round of takes: the cached takes of the last round are not asked for again.
        fix.take = (fix.take ?? 0) + 1;
      }
      fs.mkdirSync(path.dirname(soundFixesFile(files)), { recursive: true });
      files.write(soundFixesFile(files), SoundFixes.parse(fixes));
    };
    return ctx.jobs.start(slug, ['sound', slug, '--redo', ids.join(',')], `sound ${ids.length === 1 ? ids[0] : `${ids.length} sounds`}`, ctx.by, prepare);
  },
});
