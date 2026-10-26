// diorama cast <slug>: the hero and every NPC of world.json as cut-out figures the runtime walks around.
import { defineCommand, takeOption } from '../registry.ts';
import { paintFigure, type Who } from '../scene/cast.ts';
import { WorldFiles } from '../world/files.ts';

defineCommand({
  name: 'cast',
  usage: 'cast <slug> [key...]     paint the hero and NPCs with Muse, cut them out with SAM 3.1 (cast/<key>.png) [--take N]',
  async run(args) {
    const take = Number(takeOption(args, 'take', '0'));
    const [slug, ...only] = args;
    if (!slug) throw new Error('usage: diorama cast <slug> [key...] [--take N]');
    const files = new WorldFiles(slug);
    const world = files.world();
    const npcs = world.places.flatMap((p) => p.things.filter((t) => t.role === 'npc'));
    const cast: Who[] = [world.hero, ...new Map(npcs.map((n) => [n.key, n])).values()].filter((w) => !only.length || only.includes(w.key));
    await Promise.all(cast.map(async (who) => {
      const { painting, figure } = await paintFigure(files.memo, world, who, take);
      files.write(files.path('cast', `${who.key}-painting.png`), painting);
      files.write(files.path('cast', `${who.key}.png`), figure);
      console.log(`${who.key}: ${files.path('cast', `${who.key}.png`)}`);
    }));
    console.log(`calls sent: muse ${files.memo.sent.muse}, sam ${files.memo.sent.sam}`);
  },
});
