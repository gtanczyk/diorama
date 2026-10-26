// diorama cast <slug>: the hero and every NPC of world.json as cut-out figures the runtime walks around.
import fs from 'node:fs';
import { defineCommand, takeOption } from '../registry.ts';
import { paintFigure, type Who } from '../scene/cast.ts';
import { WorldFiles } from '../world/files.ts';

defineCommand({
  name: 'cast',
  usage: 'cast <slug> [key...]     paint the hero and NPCs with Muse, cut them out with SAM 3.1 (cast/<key>.png) [--take N] [--photo me.jpg: paint the hero from a full-body photo]',
  async run(args) {
    const take = Number(takeOption(args, 'take', '0'));
    const photoPath = takeOption(args, 'photo', '');
    const [slug, ...only] = args;
    if (!slug) throw new Error('usage: diorama cast <slug> [key...] [--take N]');
    const files = new WorldFiles(slug);
    const world = files.world();
    // world --hero-photo keeps the photo next to the cast, so a plain `cast` uses it too.
    const kept = files.path('cast', `${world.hero.key}-photo.png`);
    const photo = photoPath ? fs.readFileSync(photoPath) : fs.existsSync(kept) ? fs.readFileSync(kept) : undefined;
    const npcs = world.places.flatMap((p) => p.things.filter((t) => t.role === 'npc'));
    const cast: Who[] = [world.hero, ...new Map(npcs.map((n) => [n.key, n])).values()].filter((w) => !only.length || only.includes(w.key));
    await Promise.all(cast.map(async (who) => {
      const { painting, figure } = await paintFigure(files.memo, world, who, take, who.key === world.hero.key ? photo : undefined);
      files.write(files.path('cast', `${who.key}-painting.png`), painting);
      files.write(files.path('cast', `${who.key}.png`), figure);
      console.log(`${who.key}: ${files.path('cast', `${who.key}.png`)}`);
    }));
    console.log(`calls sent: muse ${files.memo.sent.muse}, sam ${files.memo.sent.sam}`);
  },
});
