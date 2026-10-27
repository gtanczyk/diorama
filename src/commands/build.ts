// diorama build <slug> ["<idea>"]: runs the steps in order and keeps a build.json of what happened.
import fs from 'node:fs';
import { defineCommand, emit, registry, takeOption } from '../registry.ts';
import { Geometry } from '../play/geometry.ts';
import { autoFixes } from '../scene/autofix.ts';
import { Corrections, readCorrections, writeCorrections } from '../scene/corrections.ts';
import { Layout } from '../scene/layout.ts';
import { withPlay, type Play } from '../scene/playbook.ts';
import type { Finding, Verdict } from '../scene/verify.ts';
import { WorldFiles } from '../world/files.ts';

export const STEPS = ['world', 'story', 'layout', 'paint', 'masks', 'plates', 'icons', 'derive', 'backdrop', 'cast', 'model', 'sprites', 'sound', 'voices', 'verify'] as const;
type Step = (typeof STEPS)[number];
/** The steps that work place by place; `--place` runs only these, for that one place. */
export const PLACE_STEPS: readonly Step[] = ['layout', 'paint', 'masks', 'plates', 'derive', 'backdrop', 'verify'];

type Report = { place: string; ok: boolean; errors: string[]; flagged: string[]; issues: Array<Finding & { play?: Play }>; from?: Step };
type Repair = { place: string; by: 'auto'; fixes: string[]; ok: boolean };
const line = (f: Finding) => `${f.code}${f.key ? ` ${f.key}` : ''}: ${f.detail}`;

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
  usage: 'build <slug> ["<idea>"] run every step, world to verify, in order [--from STEP] [--to STEP] [--places N] [--photo room.jpg] [--hero-photo me.jpg] [--place KEY: only the place steps, for one place] [--repair off: leave errors for the agent and the person, no free fixes]',
  async run(args) {
    const from = takeOption(args, 'from', STEPS[0]) as Step;
    const to = takeOption(args, 'to', STEPS[STEPS.length - 1]) as Step;
    const places = takeOption(args, 'places', '4');
    const photo = takeOption(args, 'photo', '');
    const heroPhoto = takeOption(args, 'hero-photo', '');
    const only = takeOption(args, 'place', '');
    const repair = takeOption(args, 'repair', 'auto');
    const [slug, idea] = args;
    if (!slug) throw new Error('usage: diorama build <slug> ["<idea>"] [--from STEP] [--to STEP]');
    const range = STEPS.slice(STEPS.indexOf(from), STEPS.indexOf(to) + 1).filter((s) => !only || PLACE_STEPS.includes(s));
    if (range.length === 0) throw new Error(`steps run ${STEPS.join(' > ')}; --from ${from} --to ${to} selects none`);
    if (range[0] === 'world' && !idea) throw new Error('the world step needs an idea: diorama build <slug> "<idea>"');

    const files = new WorldFiles(slug);
    if (only && !files.world().places.some((p) => p.key === only)) throw new Error(`${slug} has no place ${only}`);
    const logFile = files.path('build.json');
    const log = (fs.existsSync(logFile) ? files.readJson(logFile) : { steps: {} }) as { steps: Record<string, unknown>; places?: Report[]; repairs?: Array<Repair & { at: string }> };
    // A place whose step threw is set aside with why; the other places go on, and so do the world's own steps.
    const broken = new Map<string, { step: Step; error: string }>();
    /** Runs a place step for the places given, side by side (as each command does inside); a place that throws is set aside. */
    const runPlaces = async (step: Step, keys: string[]) => {
      const command = registry.get(step)!;
      const exit = process.exitCode;
      const settled = await Promise.allSettled(keys.map((p) => command.run([slug, p])));
      // verify says "not playable" with its exit code; the build reports that itself, below.
      if (step === 'verify') process.exitCode = exit;
      settled.forEach((d, i) => {
        if (d.status === 'fulfilled') return;
        const error = d.reason instanceof Error ? d.reason.message : String(d.reason);
        broken.set(keys[i], { step, error });
        console.log(`${keys[i]}: ${step} failed, set aside: ${error}`);
        emit('place.fail', { place: keys[i], step, error });
      });
    };
    /** Per place: whether it is playable, everything flagged and let through, and for each error what to try (the playbook). */
    const reportOf = (place: string): Report | null => {
      const gone = broken.get(place);
      if (gone) {
        const issue = withPlay({ code: 'STEP_FAILED', key: gone.step, detail: gone.error });
        return { place, ok: false, errors: [line(issue)], flagged: [], issues: [issue], from: gone.step };
      }
      const file = files.place(place, 'verify.json');
      if (!range.includes('verify') || !fs.existsSync(file)) return null;
      const v = files.readJson(file) as Verdict;
      return { place, ok: v.ok, errors: v.errors.map(line), flagged: v.flags.map(line), issues: v.errors.map(withPlay) };
    };

    emit('build.start', { slug, steps: range });
    for (const step of range) {
      console.log(`\n# ${step}`);
      emit('step.start', { step });
      const at = new Date().toISOString();
      const started = Date.now();
      // A build runs the same commands you could run by hand, one after another.
      if (PLACE_STEPS.includes(step)) {
        // Place by place, so one place breaking stops only itself.
        const keys = files.world().places.map((p) => p.key).filter((p) => (!only || p === only) && !broken.has(p));
        if (keys.length === 0) throw new Error(`no place left to run ${step} on: ${[...broken].map(([p, b]) => `${p} broke at ${b.step} (${b.error})`).join('; ')}`);
        await runPlaces(step, keys);
        if (broken.size && keys.every((p) => broken.has(p))) {
          emit('step.fail', { step, error: [...broken.values()].map((b) => b.error).join('; ') });
          throw new Error(`${step} failed for every place: ${[...broken].map(([p, b]) => `${p}: ${b.error}`).join('; ')}`);
        }
      } else {
        try {
          await registry.get(step)!.run(step === 'world' ? [slug, idea, '--places', places, ...(photo ? ['--photo', photo] : []), ...(heroPhoto ? ['--hero-photo', heroPhoto] : [])] : [slug]);
        } catch (error) {
          emit('step.fail', { step, error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      }
      const done = { at, seconds: Math.round((Date.now() - started) / 100) / 10, sent: callsSince(files, at) };
      // A one-place rerun does not stand for the whole step.
      if (!only) {
        log.steps[step] = done;
        files.write(logFile, log);
      }
      emit('step.end', { step, ...done, ...(only && { place: only }) });
    }
    if (range.includes('verify') || broken.size) {
      const keys = files.world().places.map((p) => p.key).filter((p) => !only || p === only);
      let report = keys.map(reportOf).filter((r): r is Report => r !== null);
      // The free tier of repair: fixes the build can make itself with no model call (src/scene/autofix.ts),
      // then the place is rebuilt from the step they feed. Whatever is left goes to the agent, then the person.
      if (repair !== 'off') {
        const repairs: Repair[] = [];
        // Two passes: a bridge to one patch can bring the next patch within reach of a second bridge.
        const settled = new Set<string>();
        for (let pass = 0; pass < 2; pass++) {
          for (const r of report.filter((x) => !x.ok && !x.from && !settled.has(x.place))) {
            const dir = files.place(r.place);
            let fixes: ReturnType<typeof autoFixes>;
            try {
              const geometry = Geometry.parse(files.readJson(files.place(r.place, 'geometry.json')));
              const floors = Layout.parse(files.readJson(files.place(r.place, 'layout.json'))).floors.map((f) => f.key);
              fixes = autoFixes(geometry, floors, r.issues);
            } catch (error) {
              fixes = [];
              console.log(`${r.place}: could not look for a free fix: ${error instanceof Error ? error.message : error}`);
            }
            const before = readCorrections(dir);
            const after = Corrections.parse(JSON.parse(JSON.stringify(before)));
            for (const f of fixes) f.apply(after);
            if (fixes.length === 0 || JSON.stringify(after) === JSON.stringify(before)) {
              settled.add(r.place);
              console.log(`\n# repair ${r.place}: no free fix for ${[...new Set(r.issues.map((i) => i.code))].join(', ')}; left for the agent`);
              continue;
            }
            writeCorrections(dir, after);
            const start = fixes.some((f) => f.from === 'masks') ? 'masks' : 'derive';
            console.log(`\n# repair ${r.place}: ${fixes.map((f) => f.what).join('; ')}`);
            emit('repair.start', { place: r.place, by: 'auto', fixes: fixes.map((f) => f.what) });
            for (const step of PLACE_STEPS.slice(PLACE_STEPS.indexOf(start))) {
              if (!broken.has(r.place)) await runPlaces(step, [r.place]);
            }
            const now = reportOf(r.place)!;
            report = report.map((x) => (x.place === r.place ? now : x));
            repairs.push({ place: r.place, by: 'auto', fixes: fixes.map((f) => f.what), ok: now.ok });
            emit('repair.end', { place: r.place, by: 'auto', ok: now.ok });
            if (now.ok) settled.add(r.place);
          }
        }
        if (repairs.length) log.repairs = [...(log.repairs ?? []), ...repairs.map((x) => ({ at: new Date().toISOString(), ...x }))].slice(-50);
      }
      log.places = [...(log.places ?? []).filter((r) => !report.some((n) => n.place === r.place)), ...report];
      for (const r of report) emit('place.verdict', r);
      files.write(logFile, log);
      console.log('\n# report');
      for (const r of report) {
        console.log(`${r.place}: ${r.ok ? 'playable' : 'NOT playable'}${r.flagged.length ? `, flagged and continued: ${r.flagged.length}` : ''}`);
        for (const i of r.issues) {
          console.log(`  error  ${line(i)}`);
          if (i.play) console.log(`         try: ${i.play.tools.join(' | ')}`);
        }
        for (const f of r.flagged) console.log(`  flag   ${f}`);
      }
      if (report.some((r) => !r.ok)) process.exitCode = 1;
    }
    console.log(`\nbuild ${slug}: ${range.join(' > ')} done · ${files.path('build.json')}`);
  },
});
