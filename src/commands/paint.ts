// diorama paint <slug> [place...]: painting.png for each laid-out place.
import fs from 'node:fs';
import { Layout } from '../scene/layout.ts';
import { paintPlace } from '../scene/paint.ts';
import { defineCommand, takeOption } from '../registry.ts';
import { WorldFiles } from '../world/files.ts';

defineCommand({
  name: 'paint',
  usage: 'paint <slug> [place...]  paint laid-out places (painting.png) with Muse Image [--take N]',
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
      files.write(files.place(place.key, 'painting.png'), await paintPlace(files.memo, world, place, layout, blockin, take));
      console.log(`${place.key}: painting.png`);
    }));
    console.log(`muse calls sent: ${files.memo.sent.muse}`);
  },
});
