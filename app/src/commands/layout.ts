// diorama layout <slug> [place...]: layout.json, blockin.png (for Muse) and plan.png (for people) for each place.
import fs from 'node:fs';
import { renderBlockin, renderPlan } from '../scene/blockin.ts';
import { readCorrections } from '../scene/corrections.ts';
import { layOut } from '../scene/layout.ts';
import { defineCommand } from '../registry.ts';
import { WorldFiles } from '../world/files.ts';
import { approvedConcept } from '../world/sketch.ts';

defineCommand({
  name: 'layout',
  usage: 'layout <slug> [place...] lay out places (layout.json, blockin.png) with Muse Spark',
  async run([slug, ...only]) {
    if (!slug) throw new Error('usage: diorama layout <slug> [place...]');
    const files = new WorldFiles(slug);
    const world = files.world();
    const places = world.places.filter((p) => only.length === 0 || only.includes(p.key));
    await Promise.all(places.map(async (place) => {
      // A place made from a photo is measured from it, and the photo stands in for the block-in.
      const photoFile = files.place(place.key, 'photo.png');
      const photo = fs.existsSync(photoFile) ? fs.readFileSync(photoFile) : undefined;
      const layout = await layOut(files.memo, world, place, photo, readCorrections(files.place(place.key)).layout?.guidance, approvedConcept(files, 'place', place.key));
      files.write(files.place(place.key, 'layout.json'), layout);
      const blockin = photo ?? await renderBlockin(layout, place);
      files.write(files.place(place.key, 'blockin.png'), blockin);
      files.write(files.place(place.key, 'plan.png'), await renderPlan(layout, place, blockin, world.names));
      console.log(`${place.key}: ${layout.floors.length} floor(s), ${layout.things.length} things, horizon ${layout.horizon}`);
    }));
    console.log(`spark calls sent: ${files.memo.sent.spark}`);
  },
});
