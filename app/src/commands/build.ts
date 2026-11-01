// diorama build <slug> ["<idea>"]: runs the steps, each as soon as what it needs is made (src/world/schedule.ts):
// every place on its own, the cast, voices and sound alongside. Keeps a build.json of what happened.
import fs from 'node:fs';
import { defineCommand, emit, registry, takeOption } from '../registry.ts';
import { Geometry, personPx } from '../play/geometry.ts';
import { maskFromPng, type Mask } from '../image/mask.ts';
import { autoFixes } from '../scene/autofix.ts';
import { Corrections, readCorrections, writeCorrections } from '../scene/corrections.ts';
import { Layout } from '../scene/layout.ts';
import { withPlay, type Play } from '../scene/playbook.ts';
import { gridOf, type Finding, type Verdict } from '../scene/verify.ts';
import { WorldFiles } from '../world/files.ts';
import { drawingFiles } from '../world/drawings.ts';
import { toldFiles } from '../world/told.ts';
import { NEEDS, needs, PLACE_STEPS, STEPS, type Step } from '../world/schedule.ts';
import { itemSources } from '../scene/icons.ts';
import { Story } from '../story/schema.ts';
import { assetReport } from '../scene/assets.ts';
import { FacePreparationError } from '../scene/face-work.ts';

/** How the build's own repaints of a missing thing start, so a new take can drop them. */
const BUILD_REPAINT = 'Paint the';

export { PLACE_STEPS, STEPS } from '../world/schedule.ts';

/** What each place step leaves that later steps read; a place missing one never got past that step. */
const MADE: Partial<Record<Step, string>> = { layout: 'blockin.png', paint: 'painting.png', masks: 'masks.json', derive: 'geometry.json' };

/**
 * The earliest step before `step` whose file the place lacks, with that file; null when it has them all. Steps this
 * build ran itself (`ran`) are not looked at: they made the file or set the place aside already.
 */
export function placeGap(placeDir: string, step: Step, ran: readonly Step[] = []): { step: Step; file: string } | null {
  for (const s of PLACE_STEPS.slice(0, PLACE_STEPS.indexOf(step)).filter((x) => !ran.includes(x))) {
    const file = MADE[s];
    if (file && !fs.existsSync(`${placeDir}/${file}`)) return { step: s, file };
  }
  return null;
}

export const gapError = (place: string, gap: { step: string; file: string }) =>
  `${place} never got past ${gap.step} (no ${gap.file}): fix why ${gap.step} failed there (place_status, the job log) and rebuild the place from ${gap.step}`;

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
  usage: 'build <slug> ["<idea>"] run every step, world to verify, in order [--from STEP] [--to STEP] [--places N] [--photo room.jpg] [--hero-photo me.jpg] [--drawings DIR] [--told DIR] [--kids] [--language L] [--place KEY: only the place steps, for one place] [--repair off: leave errors for the agent and the person, no free fixes] [--max-take N: new paintings the build may ask for, default 2, 0 keeps them]',
  async run(args) {
    const from = takeOption(args, 'from', STEPS[0]) as Step;
    const to = takeOption(args, 'to', STEPS[STEPS.length - 1]) as Step;
    const places = takeOption(args, 'places', '4');
    const photo = takeOption(args, 'photo', '');
    const heroPhoto = takeOption(args, 'hero-photo', '');
    // Children's drawings and recordings of their story, and the game's language, go to the world step as they are.
    const told = takeOption(args, 'told', '');
    const worldArgs = ['drawings', 'told', 'language'].flatMap((o) => {
      const value = o === 'told' ? told : takeOption(args, o, '');
      return value ? [`--${o}`, value] : [];
    });
    const kids = args.indexOf('--kids');
    if (kids >= 0) (args.splice(kids, 1), worldArgs.push('--kids'));
    const only = takeOption(args, 'place', '');
    const repair = takeOption(args, 'repair', 'auto');
    // The highest take of a painting the build may ask for by itself (FLOOR_LOST); 0 keeps every painting as it is.
    const maxTake = Number(takeOption(args, 'max-take', '2'));
    const [slug, idea] = args;
    if (!slug) throw new Error('usage: diorama build <slug> ["<idea>"] [--from STEP] [--to STEP]');
    const range = STEPS.slice(STEPS.indexOf(from), STEPS.indexOf(to) + 1).filter((s) => !only || PLACE_STEPS.includes(s));
    if (range.length === 0) throw new Error(`steps run ${STEPS.join(' > ')}; --from ${from} --to ${to} selects none`);
    const files = new WorldFiles(slug);
    if (range[0] === 'world' && !idea && !told && toldFiles(files).length === 0 && drawingFiles(files).length === 0) throw new Error('the world step needs an idea: diorama build <slug> "<idea>" (or --told DIR, recordings of the story)');

    if (only && !files.world().places.some((p) => p.key === only)) throw new Error(`${slug} has no place ${only}`);
    const logFile = files.path('build.json');
    const log = (fs.existsSync(logFile) ? files.readJson(logFile) : { steps: {} }) as { steps: Record<string, unknown>; places?: Report[]; repairs?: Array<Repair & { at: string }> };
    // A place whose step threw is set aside with why; the other places go on, and so do the world's own steps.
    const broken = new Map<string, { step: Step; error: string }>();
    const placeStep = async (step: Step, place: string) => {
      // A place step that lost the network (every retry of a request failed: "fetch failed") gets the step
      // again after a pause, twice, before the place is set aside: an outage of a few minutes costs time, not a place.
      for (let again = 0; ; again++) {
        try {
          await registry.get(step)!.run([slug, place]);
          return;
        } catch (reason) {
          const error = reason instanceof Error ? reason.message : String(reason);
          if (again < 2 && /fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(error)) {
            console.log(`${place}: ${step} lost the network (${error.slice(0, 80)}); trying the step again in ${60 * (again + 1)} s`);
            await new Promise((r) => setTimeout(r, 60_000 * (again + 1)));
            continue;
          }
          throw reason;
        }
      }
    };
    /** Runs a place step for one place; a place that throws is set aside, the others go on. */
    const runPlace = async (step: Step, place: string) => {
      // A place an earlier job left unfinished (its paint refused, say) is set aside at the step it never got past,
      // not failed here with a missing file, so the report and job_retry point at the step to redo.
      const gap = placeGap(files.place(place), step, range);
      if (gap) {
        broken.set(place, { step: gap.step, error: gapError(place, gap) });
        console.log(`${place}: ${step} skipped: ${gapError(place, gap)}`);
        emit('place.fail', { place, step: gap.step, error: gapError(place, gap) });
        return;
      }
      try {
        await placeStep(step, place);
      } catch (reason) {
        const error = reason instanceof Error ? reason.message : String(reason);
        broken.set(place, { step, error });
        console.log(`${place}: ${step} failed, set aside: ${error}`);
        emit('place.fail', { place, step, error });
      }
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
      return { place, ok: v.ok, errors: v.errors.map(line), flagged: v.flags.map(line), issues: v.errors.map((e) => withPlay(e, v.flags)) };
    };

    emit('build.start', { slug, steps: range });
    const saved = process.exitCode;
    const optionalWarnings = new Map<Step,string[]>();
    const run = (step: Step) => range.includes(step);
    /** Each step's run: when it began, its longest single run (one place, or the world), what is still to do. */
    const runs = new Map<Step, { at: string; started: number; longest: number; left: number; done: Promise<void>; end: () => void; fail: (error: unknown) => void }>();
    for (const step of range) {
      let end!: () => void;
      let fail!: (error: unknown) => void;
      const done = new Promise<void>((resolve, reject) => ((end = resolve), (fail = reject)));
      // Whoever waits on it hears of a failure; nobody waiting is fine.
      done.catch(() => {});
      runs.set(step, { at: '', started: 0, longest: 0, left: 1, done, end, fail });
    }
    /** A world step failed: nothing waiting on an unfinished step starts, so the build ends with that failure. */
    const abort = (error: unknown) => {
      for (const r of runs.values()) r.fail(error);
    };
    /** How many runs make the step: one for the world's, one per place (known once world.json is). */
    const open = (step: Step, units: number) => {
      const r = runs.get(step)!;
      r.left = units;
      if (units === 0) r.end();
    };
    const begin = (step: Step) => {
      const r = runs.get(step)!;
      if (r.started) return Date.now();
      r.started = Date.now();
      r.at = new Date().toISOString();
      console.log(`\n# ${step}`);
      emit('step.start', { step });
      return r.started;
    };
    /** One unit of a step finished (a place, or the world's own run); the last one ends the step. */
    const finish = (step: Step, since?: number) => {
      const r = runs.get(step)!;
      if (since) r.longest = Math.max(r.longest, Date.now() - since);
      if (--r.left > 0) return;
      r.end();
      if (!r.started) return;
      // A step's time is what one place (or the world) took with it, so it adds up along the web, not the clock.
      const done = { at: r.at, seconds: Math.round(r.longest / 100) / 10, sent: callsSince(files, r.at), ...(optionalWarnings.has(step) && { status: 'incomplete', warnings: optionalWarnings.get(step) }) };
      // A one-place rerun does not stand for the whole step.
      if (!only) {
        log.steps[step] = done;
        files.write(logFile, log);
      }
      emit('step.end', { step, ...done, ...(only && { place: only }) });
    };
    /** Resolves when `step` is done everywhere (every place has finished it or was set aside); at once when not run. */
    const ready = (step: Step) => (run(step) ? runs.get(step)!.done : Promise.resolve());
    const worldStep = async (step: Step, args: string[]) => {
      await Promise.all(needs(step).map(ready));
      const since = begin(step);
      try {
        await registry.get(step)!.run(args);
      } catch (error) {
        if (step === 'faces' && error instanceof FacePreparationError) {
          optionalWarnings.set(step,error.failures);
          console.log(`Speaking animation incomplete; game build continues: ${error.failures.join('; ')}`);
          finish(step,since);return;
        }
        emit('step.fail', { step, error: error instanceof Error ? error.message : String(error) });
        abort(error);
        throw error;
      }
      finish(step, since);
    };

    const worldSteps = STEPS.filter((s) => run(s) && !PLACE_STEPS.includes(s) && s !== 'icons');
    const tasks: Array<Promise<void>> = [];
    const go = (step: Step, args: string[]) => {
      const task = worldStep(step, args);
      // Every world step is awaited at the end; this only keeps a failure from being reported twice as unhandled.
      task.catch(() => {});
      tasks.push(task);
    };
    if (run('world')) go('world', [slug, ...(idea ? [idea] : []), '--places', places, ...worldArgs, ...(photo ? ['--photo', photo] : []), ...(heroPhoto ? ['--hero-photo', heroPhoto] : [])]);
    for (const s of worldSteps.filter((s) => s !== 'world')) go(s, [slug]);

    // The places start once world.json says which there are; each goes through its steps on its own.
    const reports: Report[] = [];
    const repairs: Repair[] = [];
    let keys: string[] = [];
    const placesDone = ready('world').then(async () => {
      keys = files.world().places.map((p) => p.key).filter((p) => !only || p === only);
      for (const s of PLACE_STEPS.filter(run)) open(s, keys.length);
      // Icons, per place once its things are cut out; items picked up nowhere once the story is there.
      const story = () => (fs.existsSync(files.path('story.json')) ? Story.parse(files.readJson(files.path('story.json'))) : null);
      if (run('icons')) open('icons', keys.length + 1);
      let iconsQueue = Promise.resolve();
      const iconTasks: Array<Promise<void>> = [];
      /** items/items.json is read and written by each run, so icons runs one after another. */
      const icons = (items: () => string[] | null) => {
        const next = iconsQueue.then(async () => {
          await ready('story');
          const keys = items();
          // null: no story to say which items, so icons is run as a whole (it says there is nothing to do).
          if (keys && keys.length === 0) return finish('icons');
          const since = begin('icons');
          try {
            await registry.get('icons')!.run([slug, ...(keys ?? [])]);
          } catch (error) {
            emit('step.fail', { step: 'icons', error: error instanceof Error ? error.message : String(error) });
            abort(error);
            throw error;
          }
          finish('icons', since);
        });
        iconsQueue = next.catch(() => {});
        iconTasks.push(next);
      };
      const itemsFrom = (place: string | null) => () => {
        const s = story();
        if (!s) return place === null ? null : [];
        const placed = new Set(keys);
        return Object.entries(itemSources(s)).filter(([, from]) => (place === null ? !from || !placed.has(from.place) : from?.place === place)).map(([item]) => item);
      };
      if (run('icons')) icons(itemsFrom(null));

      const chains = await Promise.allSettled(keys.map(async (place) => {
        for (const step of PLACE_STEPS.filter(run)) {
          await Promise.all(NEEDS[step].map(ready));
          if (!broken.has(place)) {
            const since = begin(step);
            emit('place.step', { place, step });
            await runPlace(step, place);
            finish(step, since);
          } else finish(step);
          if (step === 'masks' && run('icons')) icons(itemsFrom(place));
        }
        const report = await repairPlace(place);
        if (report) {
          reports.push(report);
          // Said as soon as the place is done, so it can be played while the others are still being made.
          emit('place.verdict', report);
        }
      }));
      if (run('icons') && !run('masks')) for (const p of keys) icons(itemsFrom(p));
      for (const settled of [...chains, ...(await Promise.allSettled(iconTasks))]) if (settled.status === 'rejected') throw settled.reason;
    });
    placesDone.catch(abort);
    tasks.push(placesDone);
    // Everything runs to the end before a failure is told, so no step is cut off half written.
    const settled = await Promise.allSettled(tasks);
    process.exitCode = saved;
    const failure = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
    if (failure) throw failure.reason;
    if (keys.length && keys.every((p) => broken.has(p))) {
      const last = [...broken.values()].sort((a, b) => STEPS.indexOf(b.step) - STEPS.indexOf(a.step))[0].step;
      const error = `${last} failed for every place: ${[...broken].map(([p, b]) => `${p}: ${b.error}`).join('; ')}`;
      emit('step.fail', { step: last, error });
      throw new Error(error);
    }
    if (reports.length) {
      const report = keys.map((p) => reports.find((r) => r.place === p)).filter((r): r is Report => !!r);
      if (repairs.length) log.repairs = [...(log.repairs ?? []), ...repairs.map((x) => ({ at: new Date().toISOString(), ...x }))].slice(-50);
      log.places = [...(log.places ?? []).filter((r) => !report.some((n) => n.place === r.place)), ...report];
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
    // The cast and the sound, which verify does not look at: a character with no walk, a sound that stayed silent.
    if (['cast', 'model', 'sprites', 'sound', 'voices'].some((s) => run(s as Step))) {
      try {
        const assets = assetReport(files);
        if (assets.length) console.log(`\n# made\n${assets.map((l) => `  ${l}`).join('\n')}`);
      } catch { /* a report only */ }
    }

    /**
     * The place's verdict once its steps are done, after the free tier of repair: fixes the build can make itself
     * with no model call (src/scene/autofix.ts), then the place is rebuilt from the step they feed. Whatever is
     * left goes to the agent, then the person. Null when verify did not run and the place did not break.
     */
    async function repairPlace(place: string): Promise<Report | null> {
      let r = reportOf(place);
      if (!r || repair === 'off') return r;
      // Two passes: a bridge to one patch can bring the next patch within reach of a second bridge.
      for (let pass = 0; pass < 2 && !r.ok && !r.from; pass++) {
        const dir = files.place(place);
        let fixes: ReturnType<typeof autoFixes>;
        try {
          const geometry = Geometry.parse(files.readJson(files.place(place, 'geometry.json')));
          const floors = Layout.parse(files.readJson(files.place(place, 'layout.json'))).floors.map((f) => f.key);
          // Walk-on masks: a bridge is drawn along stairs only when they reach both floors.
          const masks: Record<string, Mask> = {};
          for (const t of geometry.things) {
            if (t.kind === 'walk-on' && t.mask && fs.existsSync(files.place(place, t.mask))) masks[t.key] = await maskFromPng(fs.readFileSync(files.place(place, t.mask)));
          }
          fixes = autoFixes(geometry, floors, r.issues, masks);
        } catch (error) {
          fixes = [];
          console.log(`${place}: could not look for a free fix: ${error instanceof Error ? error.message : error}`);
        }
        const before = readCorrections(dir);
        const after = Corrections.parse(JSON.parse(JSON.stringify(before)));
        for (const f of fixes) f.apply(after);
        if (fixes.length === 0 || JSON.stringify(after) === JSON.stringify(before)) {
          console.log(`\n# repair ${place}: no free fix for ${[...new Set(r.issues.map((i) => i.code))].join(', ')}; left for the agent`);
          break;
        }
        writeCorrections(dir, after);
        const start = fixes.some((f) => f.from === 'masks') ? 'masks' : 'derive';
        console.log(`\n# repair ${place}: ${fixes.map((f) => f.what).join('; ')}`);
        emit('repair.start', { place, by: 'auto', fixes: fixes.map((f) => f.what) });
        for (const step of PLACE_STEPS.slice(PLACE_STEPS.indexOf(start))) {
          if (!broken.has(place)) await runPlace(step, place);
        }
        r = reportOf(place)!;
        repairs.push({ place, by: 'auto', fixes: fixes.map((f) => f.what), ok: r.ok });
        emit('repair.end', { place, by: 'auto', ok: r.ok });
      }
      return recutCards(place, await paintMissing(place, await paintWays(place, await newTake(place, r))));
    }

    /**
     * A painting that left the layout so far that a floor of it cannot be walked on (FLOOR_LOST: the stairs or the trail
     * an exit leads off painted somewhere else) gets a new take of the whole painting: one Muse painting, kept in
     * corrections.json as the place's take, and the place is rebuilt from paint. At most two new takes per place; the
     * repaints the build asked for on the old painting are dropped, as they were placed for it.
     */
    /**
     * The painting kept, but an exit or item stands where the hero cannot walk (stairs across a strip of water, a can
     * on a moored boat): its stand spot was pulled back to the nearest reached floor, far from the thing. A way is
     * painted there (one Muse edit: a boardwalk or gangplank from the reached floor to the thing) and brushed onto
     * the floor the hero stands on, then the place is rebuilt from paint. Up to three ways, each asked for once.
     */
    async function paintWays(place: string, r: Report | null): Promise<Report | null> {
      if (!r || r.ok || r.from || !r.issues.some((i) => /^FLOOR_(LOST|UNREACHABLE)$|^UNREACHABLE$/.test(i.code))) return r;
      const dir = files.place(place);
      const before = readCorrections(dir);
      const after = Corrections.parse(JSON.parse(JSON.stringify(before)));
      const what: string[] = [];
      try {
        const g = Geometry.parse(files.readJson(files.place(place, 'geometry.json')));
        const floors = Layout.parse(files.readJson(files.place(place, 'layout.json'))).floors.map((f) => f.key);
        const grid = gridOf(g);
        for (const t of g.things) {
          if (what.length >= 3 || (t.role !== 'exit' && t.role !== 'item')) continue;
          const [x0, , x1, y1] = t.box;
          const to: [number, number] = [Math.round(Math.min(x1, Math.max(x0, t.stand[0]))), Math.round(y1 - 8)];
          const from: [number, number] = [Math.round(t.stand[0]), Math.round(t.stand[1])];
          const far = Math.hypot(to[0] - from[0], to[1] - from[1]);
          if (far < 70 || far > 420) continue;
          const fix = `${BUILD_REPAINT} way to the ${t.key.replace(/-/g, ' ')}: a sturdy wooden boardwalk with low railings from (${from.join(', ')}) to (${to.join(', ')}), lying on whatever is between them (water, rocks), wide enough to walk along, in the painting's own style and light; keep everything else`;
          if (after.repaint.some((x) => x.fix === fix)) continue;
          const pad = 70;
          after.repaint.push({ fix, region: [Math.max(0, Math.min(from[0], to[0]) - pad), Math.max(0, Math.min(from[1], to[1]) - pad), Math.min(1200, Math.max(from[0], to[0]) + pad), Math.min(896, Math.max(from[1], to[1]) + pad)] });
          const zone = grid.zone[grid.cellOf(...from)];
          const floor = floors[zone >= 0 ? zone : 0] ?? floors[0];
          const f = (after.floors[floor] ??= { add: [], remove: [], strokes: [] });
          // As wide as the boardwalk Muse paints (about a person's height across, at that depth), less its railings:
          // a 16 px line left most of a painted boardwalk dead ground the hero could not step on.
          const across = personPx(g, (from[1] + to[1]) / 2);
          f.strokes.push({ mode: 'add', radius: Math.round(Math.max(16, Math.min(90, 0.3 * across))), points: [from, to] });
          what.push(`painted a way to ${t.key} across ${Math.round(far)} px and brushed it onto ${floor} (one Muse edit)`);
        }
      } catch (error) {
        console.log(`${place}: could not paint a way: ${error instanceof Error ? error.message : error}`);
        return r;
      }
      if (!what.length) return r;
      writeCorrections(dir, after);
      console.log(`\n# repair ${place}: ${what.join('; ')}`);
      emit('repair.start', { place, by: 'auto', fixes: what });
      for (const step of PLACE_STEPS.slice(PLACE_STEPS.indexOf('paint'))) {
        if (!broken.has(place)) await runPlace(step, place);
      }
      const next = reportOf(place) ?? r;
      repairs.push({ place, by: 'auto', fixes: what, ok: next.ok });
      emit('repair.end', { place, by: 'auto', ok: next.ok });
      return next;
    }

    /**
     * A card whose mask leaves out a painted part of its thing (CARD_CUT: the boat's bow, a lamp on its post) leaves
     * that part smeared on the backdrop when the card slides. The flag's box says where; the thing's box is widened
     * to take it in: the cut part is brushed onto the thing's mask (as mask_brush does), so the card carries it and the
     * backdrop is made again without it. Once per cut.
     */
    async function recutCards(place: string, r: Report | null): Promise<Report | null> {
      if (!r || r.from || repair === 'off') return r;
      const file = files.place(place, 'verify.json');
      if (!fs.existsSync(file)) return r;
      const cuts = (files.readJson(file) as Verdict).flags.filter((f) => f.code === 'CARD_CUT' && f.key && f.box);
      if (!cuts.length) return r;
      const dir = files.place(place);
      const before = readCorrections(dir);
      const after = Corrections.parse(JSON.parse(JSON.stringify(before)));
      const what: string[] = [];
      for (const f of cuts) {
        // The cut part is brushed onto the thing's mask (a lantern standing on a boat's gunwale): a little of what is
        // round it comes along, which the backdrop has behind it anyway. Asking SAM again by a wider box found
        // something else and kept the old mask.
        const [x0, y0, x1, y1] = f.box!;
        const stroke = { mode: 'add' as const, radius: Math.round(Math.max(x1 - x0, y1 - y0) / 2 + 8), points: [[Math.round((x0 + x1) / 2), Math.round((y0 + y1) / 2)] as [number, number]] };
        const t = (after.things[f.key!] ??= { strokes: [] });
        if (t.strokes.some((x) => JSON.stringify(x) === JSON.stringify(stroke))) continue;
        t.strokes.push(stroke);
        what.push(`brushed the part of ${f.key} its card cut through onto its mask at [${f.box!.join(', ')}]`);
      }
      if (!what.length) return r;
      writeCorrections(dir, after);
      console.log(`\n# repair ${place}: ${what.join('; ')}`);
      emit('repair.start', { place, by: 'auto', fixes: what });
      for (const step of PLACE_STEPS.slice(PLACE_STEPS.indexOf('masks'))) {
        if (!broken.has(place)) await runPlace(step, place);
      }
      const next = reportOf(place) ?? r;
      repairs.push({ place, by: 'auto', fixes: what, ok: next.ok });
      emit('repair.end', { place, by: 'auto', ok: next.ok });
      return next;
    }

    async function newTake(place: string, r: Report | null): Promise<Report | null> {
      if (!r || r.ok || r.from || !r.issues.some((i) => i.code === 'FLOOR_LOST')) return r;
      const dir = files.place(place);
      const before = readCorrections(dir);
      const take = (before.take ?? 0) + 1;
      if (take > maxTake) return r;
      const after = Corrections.parse(JSON.parse(JSON.stringify(before)));
      after.take = take;
      after.repaint = after.repaint.filter((x) => !x.fix.startsWith(BUILD_REPAINT));
      writeCorrections(dir, after);
      const lost = r.issues.filter((i) => i.code === 'FLOOR_LOST').map((i) => i.key).join(', ');
      const what = [`painted take ${take}: floor ${lost} was painted away from its layout (one Muse painting)`];
      console.log(`\n# repair ${place}: ${what[0]}`);
      emit('repair.start', { place, by: 'auto', fixes: what });
      for (const step of PLACE_STEPS.slice(PLACE_STEPS.indexOf('paint'))) {
        if (!broken.has(place)) await runPlace(step, place);
      }
      const next = reportOf(place) ?? r;
      repairs.push({ place, by: 'auto', fixes: what, ok: next.ok });
      emit('repair.end', { place, by: 'auto', ok: next.ok });
      return next;
    }

    /**
     * A thing the story needs that Spark finds nowhere in the painting: no mask fix can find what was never painted,
     * so it gets one Muse edit at its layout box (the one repaint_region per place the agent may make unasked), and
     * the place is rebuilt from paint. Once per thing: a repaint already asked for it is not asked again.
     */
    async function paintMissing(place: string, r: Report | null): Promise<Report | null> {
      if (!r || r.ok || r.from) return r;
      const keys = [...new Set(r.issues.filter((i) => i.code === 'THING_NOT_PAINTED' && i.key).map((i) => i.key!))];
      if (!keys.length) return r;
      const dir = files.place(place);
      const before = readCorrections(dir);
      const after = Corrections.parse(JSON.parse(JSON.stringify(before)));
      const asked: string[] = [];
      try {
        const layout = Layout.parse(files.readJson(files.place(place, 'layout.json')));
        const listed = files.world().places.find((p) => p.key === place)?.things ?? [];
        for (const key of keys) {
          const t = layout.things.find((x) => x.key === key);
          if (!t) continue;
          const looks = (listed.find((x) => x.key === key)?.looks ?? key.replace(/-/g, ' ')).replace(/^(a|an|the)\s+/i, '');
          const fix = `${BUILD_REPAINT} ${looks} here, clearly visible and whole, standing where it meets the floor, in the painting's own style and light; keep everything around it`;
          if (after.repaint.some((x) => x.fix === fix)) continue;
          // The layout box with room round it, so Muse can fit the thing in, at least 120 px each way.
          const w = Math.max(120, t.width * 1.4), h = Math.max(120, t.height * 1.3);
          const region: [number, number, number, number] = [
            Math.max(0, Math.round(t.x - w / 2)), Math.max(0, Math.round(t.footY - h + 12)),
            Math.min(1200, Math.round(t.x + w / 2)), Math.min(896, Math.round(t.footY + 24)),
          ];
          after.repaint.push({ region, fix });
          asked.push(key);
        }
      } catch (error) {
        console.log(`${place}: could not ask for a repaint: ${error instanceof Error ? error.message : error}`);
        return r;
      }
      if (!asked.length) return r;
      writeCorrections(dir, after);
      const what = asked.map((k) => `repainted ${k} at its layout box (one Muse edit)`);
      console.log(`\n# repair ${place}: ${what.join('; ')}`);
      emit('repair.start', { place, by: 'auto', fixes: what });
      for (const step of PLACE_STEPS.slice(PLACE_STEPS.indexOf('paint'))) {
        if (!broken.has(place)) await runPlace(step, place);
      }
      const next = reportOf(place) ?? r;
      repairs.push({ place, by: 'auto', fixes: what, ok: next.ok });
      emit('repair.end', { place, by: 'auto', ok: next.ok });
      return next;
    }
    console.log(`\nbuild ${slug}: ${range.join(' > ')} done · ${files.path('build.json')}`);
  },
});
