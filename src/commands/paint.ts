// diorama paint <slug> [place...]: painting.png for each laid-out place.
import fs from 'node:fs';
import { writeBrief } from '../scene/brief.ts';
import { Layout } from '../scene/layout.ts';
import { paintPlace } from '../scene/paint.ts';
import { defineCommand, takeOption } from '../registry.ts';
import { WorldFiles } from '../world/files.ts';

defineCommand({
  name: 'paint',
  usage: 'paint <slug> [place...]  brief (Spark) and paint (Muse Image) laid-out places [--take N]',
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
      files.write(files.place(place.key, 'painting.png'), await paintPlace(files.memo, world, place, layout, blockin, brief, take));
      console.log(`${place.key}: painting.png`);
    }));
    console.log(`calls sent: spark ${files.memo.sent.spark}, muse ${files.memo.sent.muse}`);
  },
});
