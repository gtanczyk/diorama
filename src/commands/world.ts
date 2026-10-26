// diorama world <slug> "<idea>": the first step of every build.
import fs from 'node:fs';
import { defineCommand, takeOption } from '../registry.ts';
import { describePerson, describePhoto, framePhoto, normalisePhoto } from '../scene/photo.ts';
import { designWorld } from '../world/design.ts';
import { WorldFiles } from '../world/files.ts';

defineCommand({
  name: 'world',
  usage: 'world <slug> "<idea>"   design a world (world.json) with Muse Spark [--places N] [--photo room.jpg: a real room is the first place] [--hero-photo me.jpg: a real person is the hero]',
  async run(args) {
    const places = Number(takeOption(args, 'places', '4'));
    const photoFile = takeOption(args, 'photo', '');
    const heroFile = takeOption(args, 'hero-photo', '');
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
    let hero;
    if (heroFile) {
      const photo = await normalisePhoto(fs.readFileSync(heroFile));
      hero = await describePerson(files.memo, photo);
      files.write(files.path('cast', `${hero.key}-photo.png`), photo);
      console.log(`hero from photo: ${hero.key}, ${hero.looks}`);
    }
    const designed = await designWorld(files.memo, hero ? `${idea}\nThe hero is ${hero.looks}` : idea, places, room);
    const world = hero ? { ...designed, hero } : designed;
    files.write(files.path('world.json'), world);
    console.log(`${world.title}: ${world.places.map((p) => p.key).join(' · ')}`);
    console.log(`spark calls sent: ${files.memo.sent.spark}`);
  },
});
