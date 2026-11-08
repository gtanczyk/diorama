// Drawings as the world: photos of drawings on paper (a child's, or a grown-up's sketch), each read by Spark into the
// hero, an NPC, an item, a prop or a place, kept with the world (drawings/) and used by world, paint, cast and icons.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import type { Memo } from '../meta/memo.ts';
import { askSparkJson } from '../meta/spark.ts';
import type { WorldFiles } from './files.ts';
import { Slug, type Place, type World } from './schema.ts';

export const PICTURE = /\.(png|jpe?g|webp|heic|heif|gif|tiff?)$/i;

export const Drawn = z.object({
  file: z.string(),
  /** player: another hero, for another gamepad (only the grown-up marks one, kinds.json); it walks beside the hero, in no place. */
  kind: z.enum(['hero', 'npc', 'player', 'item', 'prop', 'place']),
  key: Slug,
  looks: z.string().min(3),
  /** Who drew it, as Spark sees it: a grown-up's sketch makes no kids' game and keeps its own medium (absent = a child). */
  by: z.enum(['child', 'grown-up']).optional(),
  /** Its medium and hand, as the world's style: a grown-up's ("fountain-pen ink hatching, grey watercolour wash") or a child's ("oil pastel on white paper"). */
  medium: z.string().optional(),
});
export type Drawn = z.infer<typeof Drawn>;

/** Upright, paper evened out, at most 1600 px on the long side: what Spark and Muse get. */
export function normaliseDrawing(photo: Buffer): Promise<Buffer> {
  return sharp(photo).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).normalise().png().toBuffer();
}

/** The drawings kept with a world, in name order (drawings/*.png). */
export function drawingFiles(files: WorldFiles): string[] {
  const dir = files.path('drawings');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort() : [];
}

/** A file's name as kept: lowercase kebab, short. */
export const keptName = (file: string) => path.basename(file).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'x';

/** Copies photos of drawings from a folder into the world, normalised, numbered after the ones already there. */
export async function keepDrawings(files: WorldFiles, from: string): Promise<string[]> {
  const sources = fs.statSync(from).isDirectory()
    ? fs.readdirSync(from).filter((f) => PICTURE.test(f)).sort().map((f) => path.join(from, f))
    : [from];
  const kept: string[] = [];
  for (const source of sources) {
    const stem = keptName(source);
    // Building again with the same folder keeps each drawing once.
    if (drawingFiles(files).some((f) => f.slice(3) === `${stem}.png`)) continue;
    const name = `${String(drawingFiles(files).length + 1).padStart(2, '0')}-${stem}.png`;
    files.write(files.path('drawings', name), await normaliseDrawing(fs.readFileSync(source)));
    kept.push(name);
  }
  return kept;
}

/** What each drawing was made into, from drawings.json; empty for a world without drawings. */
export function readDrawn(files: WorldFiles): Drawn[] {
  const file = files.path('drawings.json');
  if (!fs.existsSync(file)) return [];
  const parsed = z.array(Drawn).safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
  return parsed.success ? parsed.data : [];
}

/** True when every drawing is a grown-up's sketch: then the world is no kids' game and keeps the sketches' own medium. */
export const grownUpDrawings = (drawn: Drawn[]) => drawn.length > 0 && drawn.every((d) => d.by === 'grown-up');

/** A world for children: said so, or made from drawings and not every one of them a grown-up's sketch. */
export const kidsWorld = (files: WorldFiles, world: World) => world.audience === 'kids' || (fs.existsSync(files.path('drawings')) && !grownUpDrawings(readDrawn(files)));

/** Whose drawings the painters are shown, by the world's audience. */
export const drawers = (world: Pick<World, 'audience'>) => world.audience === 'kids'
  ? { one: "a child's drawing", many: "children's drawings", who: 'the child who drew it', whoAll: 'the children' }
  : { one: "an artist's sketch", many: "the artist's sketches", who: 'the artist who drew it', whoAll: 'the artist' };

/** The style of a world made from grown-ups' sketches: their own medium and line, finished into a game. */
export function sketchStyle(drawn: Drawn[]): string {
  const media = [...new Set(drawn.map((d) => d.medium?.trim()).filter((m): m is string => !!m))];
  return `the artist's own sketchbook drawings come alive as finished game art: ${media[0] ?? 'confident pen and ink lines with a light wash'}, the same hand, line weight and palette as the sketches, drawn loose but with clear readable shapes, depth and soft light, paper texture showing through the colour`;
}

/** The drawing a character, item or place was made from, if one was drawn. */
export function drawingFor(files: WorldFiles, key: string): Buffer | undefined {
  const drawn = readDrawn(files).find((d) => d.key === key);
  return drawn && fs.existsSync(files.path('drawings', drawn.file)) ? fs.readFileSync(files.path('drawings', drawn.file)) : undefined;
}

export const Kind = Drawn.shape.kind;
export type Kind = z.infer<typeof Kind>;

/** What the grown-up said a drawing is (drawings/kinds.json, by file), over what Spark sees. */
export function readKinds(files: WorldFiles): Record<string, Kind> {
  const file = files.path('drawings', 'kinds.json');
  const parsed = z.record(z.string(), Kind).safeParse(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});
  return parsed.success ? parsed.data : {};
}

/** A kids' world looks like this, so a character painted from a drawing before the world exists is the one the game uses. */
export const KIDS_STYLE = "the children's own drawings come alive: wax crayon and felt-tip texture, solidly coloured, bold simple rounded shapes with thick dark outlines, bright clean colours, soft sunny light, friendly and readable at a glance";

/**
 * The style of a world from children's drawings, in the medium they drew with: an oil-pastel dinosaur stays thick waxy
 * pastel strokes with paper showing through, not the crayon and felt-tip look every kids' world got before.
 */
export function kidsStyle(drawn: Drawn[]): string {
  const media = [...new Set(drawn.filter((d) => d.by !== 'grown-up').map((d) => d.medium?.trim()).filter((m): m is string => !!m && !/^(wax )?crayons?$|felt[- ]?tip/i.test(m)))];
  if (!media.length) return KIDS_STYLE;
  return `the children's own drawings come alive: ${media.join(' and ')}, the same strokes, smudges and colours as the drawings, the paper's texture showing through the colour in places, bold simple readable shapes with dark outlines, warm light, friendly and readable at a glance`;
}

const KIND_TEXT = `- by: "child" when a young child drew it (crayon, felt-tip, simple flat shapes) or "grown-up" for a sketch by a teen or an adult (confident pen, pencil, ink, marker, watercolour or digital lines, perspective, hatching, notes)
- medium: for a grown-up's sketch, its medium and look in a dozen words, as a painter's style ("fountain-pen ink hatching with a grey and ochre watercolour wash on cream paper"); for a child's, its medium and look in a few words ("oil pastel, thick waxy strokes and smudges on white paper", "watercolour and pencil", "wax crayon")
- kind: "character" (someone: a person, an animal, a creature), "item" (a small thing to pick up and carry), "prop" (a big thing that stays in a place) or "place" (a whole scene: a landscape, a room, a house with its surroundings)
- key: a kebab-case English name for it ("green-dragon", "blue-hat", "mushroom-forest")
- looks: what was drawn, as a description a painter can follow: shape, every colour, clothes, face, what it holds. Describe the drawing kindly as the real thing it shows (a "green dragon with orange wings and a round light-green belly", not "scribbles"). For a character or a thing, only it, not the sun, sky or ground drawn around it. For a place: what it shows front to back.
Ignore any name written on the paper, the paper itself and the table.`;

/** Spark says what one drawing is, as soon as its photo arrives (no story needed yet). */
export async function readDrawing(memo: Memo, image: Buffer, file: string, taken: string[] = []): Promise<Drawn> {
  const prompt = `Someone drew this picture for a 2D point-and-click adventure game: a child (often 5 or 6, for a game the class makes together) or a grown-up sketching their own world. Say who drew it and what it is in the game:
${KIND_TEXT}${taken.length ? `\nKeys already used by other drawings: ${taken.join(', ')}. Use one of them only when this drawing shows that same thing again.` : ''}

Reply with JSON only: {"by": "child | grown-up", "medium": "...", "kind": "...", "key": "...", "looks": "..."}`;
  let ask = prompt;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const answer = await askSparkJson<{ by?: string; medium?: string; kind?: string; key?: string; looks?: string }>(memo, { label: `drawing:${file}#${attempt}`, prompt: ask, images: [image], personal: true });
    const by = answer?.by === 'grown-up' || answer?.by === 'adult' ? 'grown-up' as const : 'child' as const;
    const medium = answer?.medium?.trim() || undefined;
    const parsed = Drawn.safeParse({ file, kind: answer?.kind === 'character' ? 'npc' : answer?.kind, key: answer?.key, looks: answer?.looks, by, ...(medium && { medium }) });
    if (parsed.success) return parsed.data;
    ask = `${prompt}\n\nYour last answer was:\n${JSON.stringify(answer)}\n\nFix: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
  }
  throw new Error(`Spark could not read the drawing ${file} in 3 tries`);
}

/** Every kept drawing read (each once, kept in drawings.json), with what the grown-up said over what Spark saw. */
export async function readDrawings(memo: Memo, files: WorldFiles): Promise<Drawn[]> {
  const names = drawingFiles(files);
  const known = new Map(readDrawn(files).map((d) => [d.file, d]));
  // All at once (Spark's lane cap paces them): a class's 25 drawings read one after another took 6 minutes.
  // A drawing read now keeps its own key, so two children's princesses are two princesses; ones read before keep theirs.
  const read = await Promise.all(names.map((file) => known.get(file) ?? readDrawing(memo, fs.readFileSync(files.path('drawings', file)), file)));
  const drawn = ownKeys(read, new Set(names.filter((f) => known.has(f))));
  const kinds = readKinds(files);
  for (const d of drawn) if (kinds[d.file]) d.kind = kinds[d.file];
  return oneHero(drawn, drawn.find((d) => kinds[d.file] === 'hero')?.key);
}

/** A new drawing whose key another drawing has gets a number ("princess-2"); drawings in `kept` keep their keys as they are. */
export function ownKeys(drawn: Drawn[], kept = new Set<string>()): Drawn[] {
  const taken = new Set(drawn.filter((d) => kept.has(d.file)).map((d) => d.key));
  return drawn.map((d) => {
    if (kept.has(d.file)) return d;
    let key = d.key;
    for (let n = 2; taken.has(key); n++) key = `${d.key}-${n}`;
    taken.add(key);
    return key === d.key ? d : { ...d, key };
  });
}

/**
 * At most `places` drawn places stay places, the first ones; a drawn place over that becomes a big prop inside one.
 * Every drawn place was a place to paint, mask and check, so a class's 8 place drawings made an 8-place, 40-minute build.
 */
export function fitPlaces(drawn: Drawn[], places: number): Drawn[] {
  let kept = 0;
  return drawn.map((d) => {
    if (d.kind !== 'place' || ++kept <= places) return d;
    return { ...d, kind: 'prop', looks: `${d.looks} (drawn as a whole place; here it is one big thing in a place: a picture, a model, a view through a window)` };
  });
}

/** Exactly one character leads: the one asked for, else the one already leading, else the first drawn. */
export function oneHero(drawn: Drawn[], hero?: string): Drawn[] {
  const characters = drawn.filter((d) => d.kind === 'hero' || d.kind === 'npc');
  const lead = (hero && characters.find((d) => d.key === hero)) ?? characters.find((d) => d.kind === 'hero') ?? characters[0];
  for (const d of characters) d.kind = lead && d.key === lead.key ? 'hero' : 'npc';
  return drawn;
}

/**
 * The other heroes, one per extra gamepad: characters a child drew and the grown-up marked "player". They are painted
 * and rigged with the cast and walk beside the hero; they belong to no place and say nothing in the story.
 */
export function players(files: WorldFiles): Array<{ key: string; looks: string }> {
  const world = files.world();
  const taken = new Set([world.hero.key, ...world.places.flatMap((p) => p.things.map((t) => t.key))]);
  return [...new Map(readDrawn(files).filter((d) => d.kind === 'player' && !taken.has(d.key)).map((d) => [d.key, { key: d.key, looks: d.looks }])).values()];
}

/** What the world designer is told: every drawing is in the world, under its key, as drawn. */
export function drawingsBrief(drawn: Drawn[], style = KIDS_STYLE, chooseHero = false): string {
  const who = grownUpDrawings(drawn) ? 'The artist sketched' : 'The children drew';
  const once = [...new Map(drawn.map((d) => [d.key, d])).values()];
  const line = (d: Drawn) => chooseHero && (d.kind === 'hero' || d.kind === 'npc')
    ? `- a character, key "${d.key}": ${d.looks} (hero or npc according to the creator's idea and clarifications)` : ({
    hero: `- the hero, key "${d.key}": ${d.looks}`,
    npc: `- an npc in one of the places, key "${d.key}", role "npc": ${d.looks}`,
    item: `- an item to pick up in one of the places, key "${d.key}", role "item": ${d.looks}`,
    prop: `- a prop in one of the places, key "${d.key}", role "prop": ${d.looks}`,
    place: `- a place, key "${d.key}": ${d.looks}`,
    player: '',
  })[d.kind];
  return `${who} these, and every one of them must be in the world, under exactly this key, looking as drawn:
${once.filter((d) => d.kind !== 'player').map(line).join('\n')}
${chooseHero ? 'Choose exactly one of these drawn characters as the hero according to the creator\'s idea and answers; the other characters are NPCs. Do not choose the first drawing just because it came first.' : ''}
The style is exactly: "${style}".`;
}

/** What the designed world left out of the drawings, said so Spark can put it back. */
export function drawnIssues(world: World, drawn: Drawn[]): string[] {
  const things = new Map(world.places.flatMap((p) => p.things.map((t) => [t.key, t.role] as const)));
  const places = new Set(world.places.map((p) => p.key));
  return [...new Map(drawn.map((d) => [d.key, d])).values()].flatMap((d) => {
    if (d.kind === 'hero') return world.hero.key === d.key ? [] : [`the hero's key must be "${d.key}" (the hero was drawn)`];
    if (d.kind === 'player') return [];
    if (d.kind === 'place') return places.has(d.key) ? [] : [`the place "${d.key}" was drawn: it must be one of the places, with that key`];
    const role = things.get(d.key);
    if (!role) return [`"${d.key}" was drawn: it must be a thing with role "${d.kind}" in one of the places`];
    // A drawn house or cave may well be the way into the next place.
    if (role === d.kind || (d.kind === 'prop' && role === 'exit')) return [];
    return [`"${d.key}" was drawn as ${d.kind === 'item' ? 'an item' : `a ${d.kind}`}: its role must be "${d.kind}"`];
  });
}

/** A grown-up's sketch of the whole place: drawn in perspective, it sets the camera Muse paints with, so the
 * layout starts from it like an approved concept (a child's flat drawing leaves the composition to the layout). */
export function placeSketch(files: WorldFiles, key: string): Buffer | undefined {
  const drawn = readDrawn(files).find((d) => d.key === key && d.kind === 'place' && d.by === 'grown-up');
  return drawn ? drawingFor(files, key) : undefined;
}

/** The drawings a place's painting follows: the place itself first, then what was drawn of the props and items in it (three at most). */
export function drawingsIn(files: WorldFiles, place: Place): Array<{ key: string; image: Buffer }> {
  const keys = [place.key, ...place.things.filter((t) => t.role !== 'npc').map((t) => t.key)];
  return keys.flatMap((key) => {
    const image = drawingFor(files, key);
    return image ? [{ key, image }] : [];
  }).slice(0, 3);
}
