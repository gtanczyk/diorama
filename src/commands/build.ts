// diorama build <slug> ["<idea>"]: runs the steps in order and keeps a build.json of what happened.
import fs from 'node:fs';
import { defineCommand, registry, takeOption } from '../registry.ts';
import type { Finding, Verdict } from '../scene/verify.ts';
import { WorldFiles } from '../world/files.ts';

const STEPS = ['world', 'story', 'layout', 'paint', 'masks', 'plates', 'derive', 'verify'] as const;
type Step = (typeof STEPS)[number];

/** Model calls sent (not answered from the memo) since `since`, read from the memo's call log. */
function callsSince(files: WorldFiles, since: string): Record<string, number> {
  const log = files.path('memo', 'calls.jsonl');
  const counts: Record<string, number> = { spark: 0, muse: 0, sam: 0 };
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
  usage: 'build <slug> ["<idea>"] run every step, world to verify, in order [--from STEP] [--to STEP] [--places N]',
  async run(args) {
    const from = takeOption(args, 'from', STEPS[0]) as Step;
    const to = takeOption(args, 'to', STEPS[STEPS.length - 1]) as Step;
    const places = takeOption(args, 'places', '4');
    const [slug, idea] = args;
    if (!slug) throw new Error('usage: diorama build <slug> ["<idea>"] [--from STEP] [--to STEP]');
    const range = STEPS.slice(STEPS.indexOf(from), STEPS.indexOf(to) + 1);
    if (range.length === 0) throw new Error(`steps run ${STEPS.join(' > ')}; --from ${from} --to ${to} selects none`);
    if (range[0] === 'world' && !idea) throw new Error('the world step needs an idea: diorama build <slug> "<idea>"');

    const files = new WorldFiles(slug);
    const logFile = files.path('build.json');
    const log = (fs.existsSync(logFile) ? files.readJson(logFile) : { steps: {} }) as { steps: Record<string, unknown> };
    for (const step of range) {
      console.log(`\n# ${step}`);
      const at = new Date().toISOString();
      const started = Date.now();
      // A build runs the same commands you could run by hand, one after another.
      await registry.get(step)!.run(step === 'world' ? [slug, idea, '--places', places] : [slug]);
      log.steps[step] = { at, seconds: Math.round((Date.now() - started) / 100) / 10, sent: callsSince(files, at) };
      files.write(logFile, log);
    }
    if (range.includes('verify')) {
      // The report: per place, whether it is playable and everything that was flagged and let through.
      const report = files.world().places.map((place) => {
        const file = files.place(place.key, 'verify.json');
        if (!fs.existsSync(file)) return { place: place.key, ok: false, errors: ['no verify.json'], flagged: [] };
        const v = files.readJson(file) as Verdict;
        const line = (f: Finding) => `${f.code}${f.key ? ` ${f.key}` : ''}: ${f.detail}`;
        return { place: place.key, ok: v.ok, errors: v.errors.map(line), flagged: v.flags.map(line) };
      });
      Object.assign(log, { places: report });
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
