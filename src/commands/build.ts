// diorama build <slug> ["<idea>"]: runs the steps in order and keeps a build.json of what happened.
import fs from 'node:fs';
import { defineCommand, emit, registry, takeOption } from '../registry.ts';
import type { Finding, Verdict } from '../scene/verify.ts';
import { WorldFiles } from '../world/files.ts';

export const STEPS = ['world', 'story', 'layout', 'paint', 'masks', 'plates', 'derive', 'backdrop', 'cast', 'model', 'sprites', 'sound', 'voices', 'verify'] as const;
type Step = (typeof STEPS)[number];
/** The steps that work place by place; `--place` runs only these, for that one place. */
export const PLACE_STEPS: readonly Step[] = ['layout', 'paint', 'masks', 'plates', 'derive', 'backdrop', 'verify'];

/** Model calls sent (not answered from the memo) since `since`, read from the memo's call log. */
function callsSince(files: WorldFiles, since: string): Record<string, number> {
  const log = files.path('memo', 'calls.jsonl');
  const counts: Record<string, number> = { spark: 0, muse: 0, sam: 0, sound: 0, music: 0, voice: 0 };
  if (!fs.existsSync(log)) return counts;
  for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
    if (!line) continue;
    const call = JSON.parse(line) as { at: string; model: string; hit: boolean };
    if (call.at >= since && !call.hit) counts[call.model]++;
  }
  return counts;
}

defineCommand({
  name: 'build',
  usage: 'build <slug> ["<idea>"] run every step, world to verify, in order [--from STEP] [--to STEP] [--places N] [--photo room.jpg] [--hero-photo me.jpg] [--place KEY: only the place steps, for one place]',
  async run(args) {
    const from = takeOption(args, 'from', STEPS[0]) as Step;
    const to = takeOption(args, 'to', STEPS[STEPS.length - 1]) as Step;
    const places = takeOption(args, 'places', '4');
    const photo = takeOption(args, 'photo', '');
    const heroPhoto = takeOption(args, 'hero-photo', '');
    const only = takeOption(args, 'place', '');
    const [slug, idea] = args;
    if (!slug) throw new Error('usage: diorama build <slug> ["<idea>"] [--from STEP] [--to STEP]');
    const range = STEPS.slice(STEPS.indexOf(from), STEPS.indexOf(to) + 1).filter((s) => !only || PLACE_STEPS.includes(s));
    if (range.length === 0) throw new Error(`steps run ${STEPS.join(' > ')}; --from ${from} --to ${to} selects none`);
    if (range[0] === 'world' && !idea) throw new Error('the world step needs an idea: diorama build <slug> "<idea>"');

    const files = new WorldFiles(slug);
    if (only && !files.world().places.some((p) => p.key === only)) throw new Error(`${slug} has no place ${only}`);
    const logFile = files.path('build.json');
    const log = (fs.existsSync(logFile) ? files.readJson(logFile) : { steps: {} }) as { steps: Record<string, unknown> };
    emit('build.start', { slug, steps: range });
    for (const step of range) {
      console.log(`\n# ${step}`);
      emit('step.start', { step });
      const at = new Date().toISOString();
      const started = Date.now();
      // A build runs the same commands you could run by hand, one after another.
      try {
        await registry.get(step)!.run(step === 'world' ? [slug, idea, '--places', places, ...(photo ? ['--photo', photo] : []), ...(heroPhoto ? ['--hero-photo', heroPhoto] : [])] : [slug, ...(only ? [only] : [])]);
      } catch (error) {
        emit('step.fail', { step, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      const done = { at, seconds: Math.round((Date.now() - started) / 100) / 10, sent: callsSince(files, at) };
      // A one-place rerun does not stand for the whole step.
      if (!only) {
        log.steps[step] = done;
        files.write(logFile, log);
      }
      emit('step.end', { step, ...done, ...(only && { place: only }) });
    }
    if (range.includes('verify')) {
      // The report: per place, whether it is playable and everything that was flagged and let through.
      const report = files.world().places.filter((p) => !only || p.key === only).map((place) => {
        const file = files.place(place.key, 'verify.json');
        if (!fs.existsSync(file)) return { place: place.key, ok: false, errors: ['no verify.json'], flagged: [] };
        const v = files.readJson(file) as Verdict;
        const line = (f: Finding) => `${f.code}${f.key ? ` ${f.key}` : ''}: ${f.detail}`;
        return { place: place.key, ok: v.ok, errors: v.errors.map(line), flagged: v.flags.map(line) };
      });
      if (only) Object.assign(log, { places: [...((log as { places?: typeof report }).places ?? []).filter((r) => r.place !== only), ...report] });
      else Object.assign(log, { places: report });
      for (const r of report) emit('place.verdict', r);
      files.write(logFile, log);
      console.log('\n# report');
      for (const r of report) {
        console.log(`${r.place}: ${r.ok ? 'playable' : 'NOT playable'}${r.flagged.length ? `, flagged and continued: ${r.flagged.length}` : ''}`);
        for (const e of r.errors) console.log(`  error  ${e}`);
        for (const f of r.flagged) console.log(`  flag   ${f}`);
      }
    }
    console.log(`\nbuild ${slug}: ${range.join(' > ')} done · ${files.path('build.json')}`);
  },
});
