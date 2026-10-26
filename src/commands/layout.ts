// diorama layout <slug> [place...]: layout.json and blockin.png for each place.
import { renderBlockin } from '../scene/blockin.ts';
import { layOut } from '../scene/layout.ts';
import { defineCommand } from '../registry.ts';
import { WorldFiles } from '../world/files.ts';

defineCommand({
  name: 'layout',
  usage: 'layout <slug> [place...] lay out places (layout.json, blockin.png) with Muse Spark',
  async run([slug, ...only]) {
    if (!slug) throw new Error('usage: diorama layout <slug> [place...]');
    const files = new WorldFiles(slug);
    const world = files.world();
    const places = world.places.filter((p) => only.length === 0 || only.includes(p.key));
    await Promise.all(places.map(async (place) => {
      const layout = await layOut(files.memo, world, place);
      files.write(files.place(place.key, 'layout.json'), layout);
      files.write(files.place(place.key, 'blockin.png'), await renderBlockin(layout, place));
      console.log(`${place.key}: ${layout.floors.length} floor(s), ${layout.things.length} things, horizon ${layout.horizon}`);
    }));
    console.log(`spark calls sent: ${files.memo.sent.spark}`);
  },
});
