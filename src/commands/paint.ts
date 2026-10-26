// diorama paint <slug> [place...]: painting.png for each laid-out place.
import fs from 'node:fs';
import { writeBrief } from '../scene/brief.ts';
import { critique, repaint } from '../scene/critic.ts';
import { Layout } from '../scene/layout.ts';
import { paintPlace } from '../scene/paint.ts';
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
      const first = await paintPlace(files.memo, world, place, layout, blockin, brief, take);
      files.write(files.place(place.key, 'painting-first.png'), first);
      const found = await critique(files.memo, place, brief, first);
      files.write(files.place(place.key, 'critique.json'), found);
      files.write(files.place(place.key, 'painting.png'), await repaint(files.memo, place, first, found));
      console.log(`${place.key}: painted, ${found.issues.length} fix(es)${found.issues.map((i) => ` · ${i.key} ${i.problem}`).join('')}`);
    }));
    console.log(`calls sent: spark ${files.memo.sent.spark}, muse ${files.memo.sent.muse}`);
  },
});
