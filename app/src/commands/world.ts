// diorama world <slug> "<idea>": the first step of every build.
import fs from 'node:fs';
import { defineCommand, takeOption } from '../registry.ts';
import { describePerson, describePhoto, framePhoto, normalisePhoto } from '../scene/photo.ts';
import { designWorld, type Extra } from '../world/design.ts';
import { drawingFiles, drawingsBrief, drawnIssues, fitPlaces, keepDrawings, KIDS_STYLE, oneHero, readDrawings, readKinds } from '../world/drawings.ts';
import { WorldFiles } from '../world/files.ts';
import { hearAll, Idea, ideaFromTold, keepTold } from '../world/told.ts';
import { CreativeChoices } from '../world/idea-review.ts';

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
    await designInitialWorld(files, { places, photoFile, heroFile, drawingsFrom, toldFrom, language, kidsFlag: kidsFlag >= 0, given });
  },
});

/** The same first stage is used by the optional preview, without starting later build steps. */
export async function designInitialWorld(files: WorldFiles, { places, photoFile = '', heroFile = '', drawingsFrom = '', toldFrom = '', language, kidsFlag = false, given }: { places: number; photoFile?: string; heroFile?: string; drawingsFrom?: string; toldFrom?: string; language?: string; kidsFlag?: boolean; given?: string }) {
  const briefFile = files.path('creative-brief.json');
  const choices = fs.existsSync(briefFile) ? CreativeChoices.parse((files.readJson(briefFile) as { choices: unknown }).choices) : undefined;
  const chosenStyle = choices?.style;
  // Drawings and recordings already kept with the world (the Studio uploads them there) count too.
  if (drawingsFrom) console.log(`drawings kept: ${(await keepDrawings(files, drawingsFrom)).join(', ')}`);
  if (toldFrom) console.log(`recordings kept: ${keepTold(files, toldFrom).join(', ')}`);
  const said = await hearAll(files);
  for (const s of said) console.log(`heard ${s.clip}: ${s.text}`);
  // A drawn place over the places asked for goes into a place as a prop: places are what makes a build long.
  const drawn = fitPlaces(await readDrawings(files.memo, files), places);
  for (const d of drawn) console.log(`drawing ${d.file}: ${d.kind} ${d.key}, ${d.looks}`);
  const kids = kidsFlag || drawn.length > 0 || said.length > 0;

  let idea = given;
  // The story says who leads, unless the grown-up already picked a drawing as the hero.
  const heroOf = (told: Idea) => {
    if (told.hero && !drawn.some((d) => readKinds(files)[d.file] === 'hero')) oneHero(drawn, told.hero);
  };
  if (idea) {
    // An idea written from what the children said (the Studio's kids_idea), maybe edited since: its language and hero stand.
    const told = Idea.safeParse(fs.existsSync(files.path('told', 'idea.json')) ? JSON.parse(fs.readFileSync(files.path('told', 'idea.json'), 'utf8')) : null);
    if (told.success) (language ??= told.data.language, heroOf(told.data));
  } else if (said.length || drawn.length) {
    // What the children said and drew is the idea.
    const told = await ideaFromTold(files.memo, said.map((s) => s.text), drawn);
    idea = told.idea;
    language ??= told.language;
    heroOf(told);
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
  // A clarification can choose a different lead. Do not let the default first drawing override it.
  const characters = drawn.filter(d => d.kind === 'hero' || d.kind === 'npc').map(d => d.key);
  const chooseHero = !!(choices?.answers.length || choices?.note) && characters.length > 1 && !drawn.some(d => readKinds(files)[d.file] === 'hero');
  const asks = [
    drawn.length ? drawingsBrief(drawn, chosenStyle ?? KIDS_STYLE, chooseHero) : '',
    chosenStyle ? `The creator explicitly chose this visual style: ${chosenStyle}. Preserve recognizable shapes and identities from all source drawings.` : '',
    other ? `Write the title and pitch in ${other}, the language of the players; everything else (style, shows, mood, looks, keys) stays in English for the painters.` : '',
    // The game shows a name over each speaker: in the players' language, as they call them.
    other || kids ? `Add "names": {"<key>": "name"} for the hero and every npc: a short name ${other ? `in ${other} ` : ''}the players would call them by (the name the children gave them, if they gave one; else a short friendly name a child would give).${drawn.length ? ` Name every drawn item and place too, as a child would say it${other ? ` in ${other}` : ''} ("the blue hat", "the mushroom forest").` : ''}` : '',
  ].filter(Boolean);
  const extra: Extra | undefined = asks.length ? { brief: asks.join('\n\n'), issues: (w) => {
    if (!chooseHero) return drawnIssues(w, drawn);
    if (!characters.includes(w.hero.key)) return [`Choose the hero from the drawn characters: ${characters.join(', ')}`];
    return drawnIssues(w, oneHero(drawn.map(d => ({ ...d })), w.hero.key));
  } } : undefined;
  const designed = await designWorld(files.memo, hero ? `${idea}\nThe hero is ${hero.looks}` : idea, places, room, extra);
  if (chooseHero) oneHero(drawn, designed.hero.key);
  const world = { ...designed, ...(drawn.length && { style: KIDS_STYLE }), ...(chosenStyle && { style: chosenStyle }), ...(hero && { hero }), ...(other && { language: other }), ...(kids && { audience: 'kids' as const }) };
  files.write(files.path('world.json'), world);
  if (drawingFiles(files).length) files.write(files.path('drawings.json'), drawn);
  console.log(`${world.title}: ${world.places.map((p) => p.key).join(' · ')}`);
  console.log(`spark calls sent: ${files.memo.sent.spark}`);
}
