// diorama paint <slug> [place...]: painting.png for each laid-out place.
import fs from 'node:fs';
import { writeBrief } from '../scene/brief.ts';
import { critique, repaint } from '../scene/critic.ts';
import { readCorrections } from '../scene/corrections.ts';
import { Layout } from '../scene/layout.ts';
import { paintPlace } from '../scene/paint.ts';
import { paintPhoto } from '../scene/photo.ts';
import { defineCommand, takeOption } from '../registry.ts';
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
      const brief = await writeBrief(files.memo, world, place, layout);
      files.write(files.place(place.key, 'brief.json'), brief);
      const fromPhoto = fs.existsSync(files.place(place.key, 'photo.png'));
      const first = fromPhoto
        ? await paintPhoto(files.memo, world, place, blockin, brief, take)
        : await paintPlace(files.memo, world, place, layout, blockin, brief, take);
      files.write(files.place(place.key, 'painting-first.png'), first);
      const found = await critique(files.memo, place, brief, first);
      files.write(files.place(place.key, 'critique.json'), found);
      // The person's repaints join the critic's, in the same single Muse edit.
      const asked = readCorrections(files.place(place.key)).repaint.map((r) => ({ key: 'person', problem: 'wrong' as const, region: r.region, fix: r.fix }));
      const fixes = { issues: [...found.issues, ...asked] };
      files.write(files.place(place.key, 'painting.png'), await repaint(files.memo, place, first, fixes));
      console.log(`${place.key}: painted, ${fixes.issues.length} fix(es)${fixes.issues.map((i) => ` · ${i.key} ${i.problem}`).join('')}`);
    }));
    console.log(`calls sent: spark ${files.memo.sent.spark}, muse ${files.memo.sent.muse}`);
  },
});
