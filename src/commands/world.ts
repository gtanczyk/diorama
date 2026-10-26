// diorama world <slug> "<idea>": the first step of every build.
import fs from 'node:fs';
import { defineCommand, takeOption } from '../registry.ts';
import { describePhoto, framePhoto } from '../scene/photo.ts';
import { designWorld } from '../world/design.ts';
import { WorldFiles } from '../world/files.ts';

defineCommand({
  name: 'world',
  usage: 'world <slug> "<idea>"   design a world (world.json) with Muse Spark [--places N] [--photo room.jpg: a real room is the first place]',
  async run(args) {
    const places = Number(takeOption(args, 'places', '4'));
    const photoFile = takeOption(args, 'photo', '');
    const [slug, idea] = args;
    if (!slug || !idea) throw new Error('usage: diorama world <slug> "<idea>" [--places N]');
    const files = new WorldFiles(slug);
    files.write(files.path('idea.txt'), `${idea}\n`);
    let room;
    if (photoFile) {
      const { image, crop } = await framePhoto(fs.readFileSync(photoFile));
      room = await describePhoto(files.memo, image, idea);
      files.write(files.place(room.key, 'photo.png'), image);
      files.write(files.place(room.key, 'photo.json'), crop);
      console.log(`photo: ${room.key}, ${room.things.map((t) => t.key).join(', ')} · crop ${JSON.stringify(crop.crop)}`);
    }
    const world = await designWorld(files.memo, idea, places, room);
    files.write(files.path('world.json'), world);
    console.log(`${world.title}: ${world.places.map((p) => p.key).join(' · ')}`);
    console.log(`spark calls sent: ${files.memo.sent.spark}`);
  },
});
