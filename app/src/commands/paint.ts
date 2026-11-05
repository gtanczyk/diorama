import { worldStyleReference } from '../world/style-reference.ts';
// diorama paint <slug> [place...]: painting.png for each laid-out place.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { writeBrief } from '../scene/brief.ts';
import { seedRan } from '../scene/carry.ts';
import { addsPerson, critique, paintedPeople, repaint } from '../scene/critic.ts';
import { readCorrections, writeCorrections } from '../scene/corrections.ts';
import { Layout } from '../scene/layout.ts';
import { paintPlace } from '../scene/paint.ts';
import { alignPainting, PaintingLayoutError, paintingLayoutHash } from '../scene/paint-layout.ts';
import { paintPhoto, placePicture } from '../scene/photo.ts';
import { restylePlace } from '../scene/restyle.ts';
import { refusedByFilter, reword, withWords, worded, type Words } from '../scene/words.ts';
import { defineCommand, takeOption } from '../registry.ts';
import { drawingsIn } from '../world/drawings.ts';
import { WorldFiles } from '../world/files.ts';
import { approvedConcept } from '../world/sketch.ts';
import { markStyled, placeStyle, readStyled } from '../world/styled.ts';

/** Rewords Spark may try after the image safety filter refuses a painting, before the place is set aside. */
const REWORDS = 2;

/** From this new take on, a place is painted without its approved concept (see paint below). */
const CONCEPT_TAKES = 2;

defineCommand({
  name: 'paint',
  usage: 'paint <slug> [place...]  brief, paint, critique and repaint laid-out places [--take N]',
  async run(args) {
    const takeArg = takeOption(args, 'take', '');
    const [slug, ...only] = args;
    if (!slug) throw new Error('usage: diorama paint <slug> [place...] [--take N]');
    const files = new WorldFiles(slug);
    const base = files.world();
    const places = base.places.filter((p) => only.length === 0 || only.includes(p.key));
    await Promise.all(places.map(async (place) => {
      // The place's own style, when the person gave it one, is the world's style for everything painted here.
      const style = placeStyle(files, base, place.key);
      // --take wins; else the take the place's corrections keep (a new take the build asked for stays across rebuilds).
      const take = takeArg ? Number(takeArg) : readCorrections(files.place(place.key)).take ?? 0;
      const world = { ...base, style };
      const layout = Layout.parse(files.readJson(files.place(place.key, 'layout.json')));
      const blockin = fs.readFileSync(files.place(place.key, 'blockin.png'));
      const picture = placePicture(files.place(place.key));
      const fromPhoto = !!picture;
      // An approved concept steers Muse's camera toward its own; when it keeps pulling the painting off the plan
      // (a second new take was asked for), the place is painted from the block-in alone.
      const concept = take >= CONCEPT_TAKES ? undefined : approvedConcept(files, 'place', place.key);
      if (take >= CONCEPT_TAKES && approvedConcept(files, 'place', place.key)) console.log(`  ${place.key}: take ${take}, painted from the block-in without its concept`);
      const styleReference = worldStyleReference(files, style);
      // The first painting is kept while its block-in, layout and take stay the same, even without the model
      // cache (a world copied without memo/): a person's region repaint must not repaint the whole place.
      const hash = (words?: Words) => {
        const h = createHash('sha256').update(blockin).update(JSON.stringify(layout)).update(String(take));
        // A new wording paints the place anew; a place never reworded keeps the inputs it had.
        if (words) h.update(JSON.stringify(words));
        if (concept) h.update(concept);
        if (styleReference) h.update(styleReference);
        return h.digest('hex');
      };
      let words = readCorrections(files.place(place.key)).words;
      let inputs = hash(words);
      const kept = files.place(place.key, 'painting-first.json');
      const mtime = (f: string) => fs.statSync(files.place(place.key, f)).mtimeMs;
      const have = ['painting-first.png', 'brief.json', 'critique.json'].every((f) => fs.existsSync(files.place(place.key, f)));
      // Worlds painted before this record: the first painting counts when it is newer than what it was painted from.
      const same = fs.existsSync(kept)
        ? (files.readJson(kept) as { inputs?: string }).inputs === inputs
        : have && take === 0 && mtime('painting-first.png') >= Math.max(mtime('blockin.png'), mtime('layout.json'));
      const reuse = have && same;
      const record = (fs.existsSync(kept) ? files.readJson(kept) : {}) as { inputs?: string; applied?: string[] };
      let first: Buffer;
      let found: Awaited<ReturnType<typeof critique>>;
      // The style changed since this place was painted (style_set): Muse repaints the painting as it is, every
      // fix in it, in the new style, keeping the composition, so masks, stand spots and the person's fixes still fit.
      const was = readStyled(files).places[place.key];
      const restyled = reuse && !!was && was !== style && fs.existsSync(files.place(place.key, 'painting.png'));
      if (restyled) {
        const brief = files.readJson(files.place(place.key, 'brief.json')) as Awaited<ReturnType<typeof writeBrief>>;
        const told = worded(place, words);
        first = await restylePlace(files.memo, told, fs.readFileSync(files.place(place.key, 'painting.png')), was, style, brief, take, drawingsIn(files, place));
        console.log(`  ${place.key}: repainted in the new style, composition kept`);
        files.write(files.place(place.key, 'painting-first.png'), first);
        found = await critique(files.memo, told, brief, first);
        files.write(files.place(place.key, 'critique.json'), found);
      } else if (reuse) {
        first = fs.readFileSync(files.place(place.key, 'painting-first.png'));
        found = files.readJson(files.place(place.key, 'critique.json')) as typeof found;
        // The critic is asked again (a memo hit while its prompt stays the same): what it now finds unwanted (a person
        // painted in, a double of the place's NPC) is painted out over the painting as it is; the rest stays.
        const brief = files.readJson(files.place(place.key, 'brief.json')) as Awaited<ReturnType<typeof writeBrief>>;
        // A person the critic itself once asked for ("a child kneeling at the dock edge") is taken out of its fixes,
        // so the painting is made again from the first one without them.
        const before = found.issues.length;
        found = { issues: found.issues.filter((i) => !addsPerson(i)) };
        const again = await critique(files.memo, worded(place, words), brief, first);
        // People are looked for on the painting as the game shows it, with every fix in, not only the first one.
        const shown = fs.existsSync(files.place(place.key, 'painting.png')) ? fs.readFileSync(files.place(place.key, 'painting.png')) : first;
        for (const p of shown === first || place.kind === 'drive' ? [] : await paintedPeople(files.memo, place.key, shown)) {
          again.issues.push({ key: 'person', problem: 'unwanted', region: p.box, fix: `Paint out the ${p.what}: continue what is behind them (planks, water, wall), add nothing new` });
        }
        const had = new Set(found.issues.map((i) => JSON.stringify([i.region, i.fix])));
        const unwanted = again.issues.filter((i) => i.problem === 'unwanted' && !had.has(JSON.stringify([i.region, i.fix])));
        if (unwanted.length || found.issues.length !== before) {
          found = { issues: [...found.issues, ...unwanted].slice(0, 8) };
          files.write(files.place(place.key, 'critique.json'), found);
        }
      } else {
        let brief: Awaited<ReturnType<typeof writeBrief>>;
        // When the image safety filter refuses the painting, Spark rewords the place and it is painted again;
        // the wording is kept in corrections.json, so every later paint asks with it and no rebuild repeats the refusal.
        // A wording Spark made in an earlier run counts its rewords, so the next one is a new ask.
        const before = words?.tries ?? 0;
        for (let refusals = 0; ; refusals++) {
          const told = worded(place, words);
          brief = withWords(await writeBrief(files.memo, world, told, layout), words);
          files.write(files.place(place.key, 'brief.json'), brief);
          try {
            first = picture
              ? await paintPhoto(files.memo, world, told, blockin, brief, take, concept, styleReference, picture.kind)
              : await paintPlace(files.memo, world, told, layout, blockin, brief, take, drawingsIn(files, place), concept, styleReference);
            break;
          } catch (error) {
            if (!refusedByFilter(error)) throw error;
            if (refusals >= REWORDS) {
              throw new Error(`the image safety filter refused to paint ${place.key} ${refusals + 1} times, also after ${refusals} reword(s) by Spark: `
                + `reword its scene and looks with paint_words (calm, plain words), which paints it again (${error instanceof Error ? error.message.slice(0, 160) : error})`);
            }
            words = await reword(files.memo, told, layout, brief, before + refusals);
            const fixes = readCorrections(files.place(place.key));
            fixes.words = words;
            writeCorrections(files.place(place.key), fixes);
            console.log(`  ${place.key}: the image safety filter refused the painting; Spark reworded it (kept in corrections.json), painting again: ${words.shows ?? place.shows}`);
          }
        }
        inputs = hash(words);
        files.write(files.place(place.key, 'painting-first.png'), first);
        found = await critique(files.memo, worded(place, words), brief, first);
        files.write(files.place(place.key, 'critique.json'), found);
      }
      // The person's repaints join the critic's. When the painting already has every earlier fix, only the new
      // ones are painted over it, so the rest of the place stays exactly as the person saw it.
      const asked = readCorrections(files.place(place.key)).repaint.map((r) => ({ key: 'person', problem: 'wrong' as const, region: r.region, fix: r.fix }));
      const fixes = { issues: [...found.issues, ...asked] };
      const id = (i: (typeof fixes.issues)[number]) => JSON.stringify([i.region, i.fix]);
      // After a restyle the person's repaints are in the picture already; only the critic's new findings are painted.
      const done = restyled ? asked.map(id) : reuse && fs.existsSync(files.place(place.key, 'painting.png')) ? record.applied ?? (have && !fs.existsSync(kept) ? found.issues.map(id) : null) : null;
      const onTop = done && done.every((d) => fixes.issues.some((i) => id(i) === d));
      const fresh = onTop ? fixes.issues.filter((i) => !done.includes(id(i))) : fixes.issues;
      const from = onTop && !restyled ? fs.readFileSync(files.place(place.key, 'painting.png')) : first;
      // A place built before the steps kept their painting (.ran/) gets it now, so this first repaint carries too.
      const seeded = seedRan(files.place(place.key));
      if (seeded.length) console.log(`  ${place.key}: ${seeded.join(', ')} take the painting before this repaint as the one they ran on`);
      let painting: Buffer;
      try {
        painting = await repaint(files.memo, place, from, { issues: fresh });
      } catch (error) {
        // The critic's own fixes are nice to have: a refused repaint leaves the painting as it is. The person's are not.
        if (!refusedByFilter(error) || asked.length) throw error;
        console.log(`  ${place.key}: the image safety filter refused the critic's repaint; the painting is kept without it`);
        painting = from;
      }
      // Inspect the FINAL candidate, including region fixes and restyles. Only a passing composition may
      // become the input to masks/derive. Old paid art stays on disk until a replacement passes.
      if (!fromPhoto) {
        const report = files.place(place.key, 'painting-layout.json');
        const previous = fs.existsSync(report) ? files.readJson(report) as { ok?: boolean; inputs?: string } : undefined;
        if (!previous?.ok || previous.inputs !== paintingLayoutHash(place, layout, blockin, painting)) {
          files.write(report, { ok: false, pending: true });
          try {
            const brief = files.readJson(files.place(place.key, 'brief.json')) as Awaited<ReturnType<typeof writeBrief>>;
            const aligned = await alignPainting(files.memo, worded(place, words), layout, blockin, painting, brief, take, fixes.issues.map((i) => i.fix));
            painting = aligned.painting;
            files.write(report, { ok: true, inputs: paintingLayoutHash(place, layout, blockin, painting), attempts: aligned.attempts });
          } catch (error) {
            files.write(report, { ok: false, attempts: error instanceof PaintingLayoutError ? error.attempts : [], error: String(error) });
            throw error;
          }
        }
      }
      files.write(files.place(place.key, 'painting.png'), painting);
      files.write(kept, { inputs, applied: fixes.issues.map(id) });
      markStyled(files, 'places', place.key, style);
      console.log(`${place.key}: painted, ${fresh.length} fix(es)${onTop ? ' over the last painting' : ''}${fresh.map((i) => ` · ${i.key} ${i.problem}`).join('')}`);
    }));
    console.log(`calls sent: spark ${files.memo.sent.spark}, muse ${files.memo.sent.muse}`);
  },
});
