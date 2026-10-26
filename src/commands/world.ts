// diorama world <slug> "<idea>": the first step of every build.
import { defineCommand, takeOption } from '../registry.ts';
import { designWorld } from '../world/design.ts';
import { WorldFiles } from '../world/files.ts';

defineCommand({
  name: 'world',
  usage: 'world <slug> "<idea>"   design a world (world.json) with Muse Spark [--places N]',
  async run(args) {
    const places = Number(takeOption(args, 'places', '4'));
    const [slug, idea] = args;
    if (!slug || !idea) throw new Error('usage: diorama world <slug> "<idea>" [--places N]');
    const files = new WorldFiles(slug);
    files.write(files.path('idea.txt'), `${idea}\n`);
    const world = await designWorld(files.memo, idea, places);
    files.write(files.path('world.json'), world);
    console.log(`${world.title}: ${world.places.map((p) => p.key).join(' · ')}`);
    console.log(`spark calls sent: ${files.memo.sent.spark}`);
  },
});
