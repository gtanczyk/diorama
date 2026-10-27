// diorama world <slug> "<idea>": the first step of every build.
import fs from 'node:fs';
import { defineCommand, takeOption } from '../registry.ts';
import { describePerson, describePhoto, framePhoto, normalisePhoto } from '../scene/photo.ts';
import { designWorld, type Extra } from '../world/design.ts';
import { drawingFiles, drawingsBrief, drawnIssues, keepDrawings, readDrawings } from '../world/drawings.ts';
import { WorldFiles } from '../world/files.ts';
import { hearAll, Idea, ideaFromTold, keepTold } from '../world/told.ts';

defineCommand({
  name: 'world',
  usage: 'world <slug> "<idea>"   design a world (world.json) with Muse Spark [--places N] [--photo room.jpg: a real room is the first place] [--hero-photo me.jpg: a real person is the hero] '
    + '[--drawings DIR: photos of children\'s drawings become the hero, NPCs, items and places] [--told DIR: recordings of them telling the story; without an idea, the idea is written from them] [--kids: a game for 5-7 year olds; on with drawings or recordings] [--language Polish: the game\'s text and voices; with recordings, the language spoken]',
  async run(args) {
    const places = Number(takeOption(args, 'places', '4'));
    const photoFile = takeOption(args, 'photo', '');
    const heroFile = takeOption(args, 'hero-photo', '');
    const drawingsFrom = takeOption(args, 'drawings', '');
    const toldFrom = takeOption(args, 'told', '');
    let language: string | undefined = takeOption(args, 'language', '') || undefined;
    const kidsFlag = args.indexOf('--kids');
    if (kidsFlag >= 0) args.splice(kidsFlag, 1);
    const [slug, given] = args;
    if (!slug) throw new Error('usage: diorama world <slug> "<idea>" [--places N]');
    const files = new WorldFiles(slug);
    // Drawings and recordings already kept with the world (the Studio uploads them there) count too.
    if (drawingsFrom) console.log(`drawings kept: ${(await keepDrawings(files, drawingsFrom)).join(', ')}`);
    if (toldFrom) console.log(`recordings kept: ${keepTold(files, toldFrom).join(', ')}`);
    const said = await hearAll(files);
    for (const s of said) console.log(`heard ${s.clip}: ${s.text}`);
    const drawn = await readDrawings(files.memo, files, said.map((s) => s.text).join('\n'));
    for (const d of drawn) console.log(`drawing ${d.file}: ${d.kind} ${d.key}, ${d.looks}`);
    const kids = kidsFlag >= 0 || drawn.length > 0 || said.length > 0;

    let idea = given;
    if (idea) {
      // An idea written from what the children said (the Studio's kids_idea), maybe edited since: its language stands.
      const told = Idea.safeParse(fs.existsSync(files.path('told', 'idea.json')) ? JSON.parse(fs.readFileSync(files.path('told', 'idea.json'), 'utf8')) : null);
      if (told.success) language ??= told.data.language;
    } else if (said.length || drawn.length) {
      // What the children said and drew is the idea.
      const told = await ideaFromTold(files.memo, said.map((s) => s.text), drawn);
      idea = told.idea;
      language ??= told.language;
      files.write(files.path('told', 'idea.json'), told);
      console.log(`idea from what they said (${told.language}): ${told.title}. ${told.idea}`);
    }
    if (!idea) throw new Error('usage: diorama world <slug> "<idea>" (or --told DIR with recordings of the story)');
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
    const other = language && !/^english$/i.test(language) ? language : undefined;
    const asks = [drawn.length ? drawingsBrief(drawn) : '', other ? `Write the title and pitch in ${other}, the language of the players; everything else (style, shows, mood, looks, keys) stays in English for the painters.` : ''].filter(Boolean);
    const extra: Extra | undefined = asks.length ? { brief: asks.join('\n\n'), issues: (w) => drawnIssues(w, drawn) } : undefined;
    const designed = await designWorld(files.memo, hero ? `${idea}\nThe hero is ${hero.looks}` : idea, places, room, extra);
    const world = { ...designed, ...(hero && { hero }), ...(other && { language: other }), ...(kids && { audience: 'kids' as const }) };
    files.write(files.path('world.json'), world);
    if (drawingFiles(files).length) files.write(files.path('drawings.json'), drawn);
    console.log(`${world.title}: ${world.places.map((p) => p.key).join(' · ')}`);
    console.log(`spark calls sent: ${files.memo.sent.spark}`);
  },
});
