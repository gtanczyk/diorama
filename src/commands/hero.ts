// diorama hero <slug>: the hero of world.json as a cut-out figure the runtime walks around.
import { defineCommand, takeOption } from '../registry.ts';
import { paintHero } from '../scene/hero.ts';
import { WorldFiles } from '../world/files.ts';

defineCommand({
  name: 'hero',
  usage: 'hero <slug>             paint the hero with Muse and cut them out with SAM 3.1 (hero/hero.png) [--take N]',
  async run(args) {
    const take = Number(takeOption(args, 'take', '0'));
    const [slug] = args;
    if (!slug) throw new Error('usage: diorama hero <slug> [--take N]');
    const files = new WorldFiles(slug);
    const world = files.world();
    const { painting, figure } = await paintHero(files.memo, world, take);
    files.write(files.path('hero', 'painting.png'), painting);
    files.write(files.path('hero', 'hero.png'), figure);
    console.log(`${world.hero.key}: ${files.path('hero', 'hero.png')} · calls sent: muse ${files.memo.sent.muse}, sam ${files.memo.sent.sam}`);
  },
});
