// diorama paint <slug> [place...]: painting.png for each laid-out place.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { writeBrief } from '../scene/brief.ts';
import { seedRan } from '../scene/carry.ts';
import { critique, repaint } from '../scene/critic.ts';
import { readCorrections } from '../scene/corrections.ts';
import { Layout } from '../scene/layout.ts';
import { paintPlace } from '../scene/paint.ts';
import { paintPhoto } from '../scene/photo.ts';
import { defineCommand, takeOption } from '../registry.ts';
import { drawingsIn } from '../world/drawings.ts';
import { WorldFiles } from '../world/files.ts';

defineCommand({
  name: 'paint',
  usage: 'paint <slug> [place...]  brief, paint, critique and repaint laid-out places [--take N]',
  async run(args) {
    const take = Number(takeOption(args, 'take', '0'));
    const [slug, ...only] = args;
    if (!slug) throw new Error('usage: diorama paint <slug> [place...] [--take N]');
    const files = new WorldFiles(slug);
    const world = files.world();
    const places = world.places.filter((p) => only.length === 0 || only.includes(p.key));
    await Promise.all(places.map(async (place) => {
      const layout = Layout.parse(files.readJson(files.place(place.key, 'layout.json')));
      const blockin = fs.readFileSync(files.place(place.key, 'blockin.png'));
      // The first painting is kept while its block-in, layout and take stay the same, even without the model
      // cache (a world copied without memo/): a person's region repaint must not repaint the whole place.
      const inputs = createHash('sha256').update(blockin).update(JSON.stringify(layout)).update(String(take)).digest('hex');
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
      if (reuse) {
        first = fs.readFileSync(files.place(place.key, 'painting-first.png'));
        found = files.readJson(files.place(place.key, 'critique.json')) as typeof found;
      } else {
        const brief = await writeBrief(files.memo, world, place, layout);
        files.write(files.place(place.key, 'brief.json'), brief);
        const fromPhoto = fs.existsSync(files.place(place.key, 'photo.png'));
        first = fromPhoto
          ? await paintPhoto(files.memo, world, place, blockin, brief, take)
          : await paintPlace(files.memo, world, place, layout, blockin, brief, take, drawingsIn(files, place));
        files.write(files.place(place.key, 'painting-first.png'), first);
        found = await critique(files.memo, place, brief, first);
        files.write(files.place(place.key, 'critique.json'), found);
      }
      // The person's repaints join the critic's. When the painting already has every earlier fix, only the new
      // ones are painted over it, so the rest of the place stays exactly as the person saw it.
      const asked = readCorrections(files.place(place.key)).repaint.map((r) => ({ key: 'person', problem: 'wrong' as const, region: r.region, fix: r.fix }));
      const fixes = { issues: [...found.issues, ...asked] };
      const id = (i: (typeof fixes.issues)[number]) => JSON.stringify([i.region, i.fix]);
      const done = reuse && fs.existsSync(files.place(place.key, 'painting.png')) ? record.applied ?? (have && !fs.existsSync(kept) ? found.issues.map(id) : null) : null;
      const onTop = done && done.every((d) => fixes.issues.some((i) => id(i) === d));
      const fresh = onTop ? fixes.issues.filter((i) => !done.includes(id(i))) : fixes.issues;
      const base = onTop ? fs.readFileSync(files.place(place.key, 'painting.png')) : first;
      // A place built before the steps kept their painting (.ran/) gets it now, so this first repaint carries too.
      seedRan(files.place(place.key));
      files.write(files.place(place.key, 'painting.png'), await repaint(files.memo, place, base, { issues: fresh }));
      files.write(kept, { inputs, applied: fixes.issues.map(id) });
      console.log(`${place.key}: painted, ${fresh.length} fix(es)${onTop ? ' over the last painting' : ''}${fresh.map((i) => ` · ${i.key} ${i.problem}`).join('')}`);
    }));
    console.log(`calls sent: spark ${files.memo.sent.spark}, muse ${files.memo.sent.muse}`);
  },
});
