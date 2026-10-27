// Children's drawings as the world: photos of drawings on paper, each read by Spark into the hero, an NPC,
// an item, a prop or a place, kept with the world (drawings/) and used by world, paint, cast and icons.
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
  kind: z.enum(['hero', 'npc', 'item', 'prop', 'place']),
  key: Slug,
  looks: z.string().min(3),
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

/** The drawing a character, item or place was made from, if a child drew it. */
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

/** Spark looks at every drawing (with what the children said) and says what each one is. */
export async function readDrawings(memo: Memo, files: WorldFiles, told = ''): Promise<Drawn[]> {
  const names = drawingFiles(files);
  if (names.length === 0) return [];
  const images = names.map((n) => fs.readFileSync(files.path('drawings', n)));
  const kinds = readKinds(files);
  const fixed = names.flatMap((n, i) => (kinds[n] ? [`picture ${i + 1} is ${kinds[n] === 'hero' ? 'the hero' : `${kinds[n] === 'item' ? 'an' : 'a'} ${kinds[n]}`}`] : []));
  const prompt = `Children of 5 and 6 drew these ${names.length} pictures for a 2D point-and-click adventure game they are making together; picture ${names.map((_, i) => i + 1).join(', ')} in order.${told ? `\nWhat they told about their story:\n"""\n${told}\n"""` : ''}${fixed.length ? `\nThe grown-up running the workshop decided: ${fixed.join('; ')}.` : ''}

For each picture say what it is in the game:
- kind: "hero" (the one the player walks as; exactly one picture is the hero, the main character of their story), "npc" (someone to talk to: a person, an animal, a creature), "item" (a small thing to pick up and carry), "prop" (a big thing that stays in a place) or "place" (a whole scene: a landscape, a room, a house with its surroundings)
- key: a kebab-case English name for it ("green-dragon", "blue-hat", "mushroom-forest")
- looks: what the child drew, as a description a painter can follow: shape, every colour, clothes, face, what it holds. Describe the drawing kindly as the real thing it shows (a "green dragon with orange wings and a round light-green belly", not "scribbles"). For a character or a thing, only it, not the sun, sky or ground drawn around it. For a place: what it shows front to back.
Ignore any name written on the paper, the paper itself and the table. Two pictures of the same thing get the same key.

Reply with JSON only: {"pictures": [{"picture": 1, "kind": "...", "key": "...", "looks": "..."}]}`;
  let ask = prompt;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const answer = await askSparkJson<{ pictures?: Array<{ picture?: number; kind?: string; key?: string; looks?: string }> }>(memo, { label: `drawings#${attempt}`, prompt: ask, images });
    const drawn = (Array.isArray(answer?.pictures) ? answer.pictures : []).map((a, i) => Drawn.safeParse({ file: names[(a.picture ?? i + 1) - 1], kind: a.kind, key: a.key, looks: a.looks }));
    const ok = drawn.flatMap((d) => (d.success ? [d.data] : []));
    const issues = [
      ...(ok.length < names.length ? [`describe all ${names.length} pictures, each with picture, kind, key and looks`] : []),
      ...(ok.filter((d) => d.kind === 'hero').length > 1 && new Set(ok.filter((d) => d.kind === 'hero').map((d) => d.key)).size > 1 ? ['only one character is the hero; the others are npc'] : []),
    ];
    if (issues.length === 0) {
      // What the grown-up decided stands; a hero they chose sends any other hero back among the npcs.
      for (const d of ok) if (kinds[d.file]) d.kind = kinds[d.file];
      const chosen = ok.find((d) => kinds[d.file] === 'hero');
      if (chosen) for (const d of ok) if (d.kind === 'hero' && d.key !== chosen.key) d.kind = 'npc';
      // Nobody drew a hero: the first character drawn leads.
      if (!ok.some((d) => d.kind === 'hero')) {
        const first = ok.find((d) => d.kind === 'npc');
        if (first) ok.filter((d) => d.key === first.key).forEach((d) => (d.kind = 'hero'));
      }
      return ok;
    }
    console.log(`  drawings try ${attempt}: ${issues.join('; ')}`);
    ask = `${prompt}\n\nYour last answer was:\n${JSON.stringify(answer)}\n\nFix: ${issues.join('; ')}`;
  }
  throw new Error('Spark could not read the drawings in 3 tries');
}

/** What the world designer is told: every drawing is in the world, under its key, as drawn. */
export function drawingsBrief(drawn: Drawn[]): string {
  const once = [...new Map(drawn.map((d) => [d.key, d])).values()];
  const line = (d: Drawn) => ({
    hero: `- the hero, key "${d.key}": ${d.looks}`,
    npc: `- an npc in one of the places, key "${d.key}", role "npc": ${d.looks}`,
    item: `- an item to pick up in one of the places, key "${d.key}", role "item": ${d.looks}`,
    prop: `- a prop in one of the places, key "${d.key}", role "prop": ${d.looks}`,
    place: `- a place, key "${d.key}": ${d.looks}`,
  })[d.kind];
  return `The children drew these, and every one of them must be in the world, under exactly this key, looking as drawn:
${once.map(line).join('\n')}
Style: the world looks like their drawings come alive: wax crayon and felt-tip texture, bold simple shapes, bright clean colours, friendly, readable at a glance.`;
}

/** What the designed world left out of the drawings, said so Spark can put it back. */
export function drawnIssues(world: World, drawn: Drawn[]): string[] {
  const things = new Map(world.places.flatMap((p) => p.things.map((t) => [t.key, t.role] as const)));
  const places = new Set(world.places.map((p) => p.key));
  return [...new Map(drawn.map((d) => [d.key, d])).values()].flatMap((d) => {
    if (d.kind === 'hero') return world.hero.key === d.key ? [] : [`the hero's key must be "${d.key}" (a child drew the hero)`];
    if (d.kind === 'place') return places.has(d.key) ? [] : [`a child drew the place "${d.key}": it must be one of the places, with that key`];
    const role = things.get(d.key);
    if (!role) return [`a child drew "${d.key}": it must be a thing with role "${d.kind}" in one of the places`];
    // A drawn house or cave may well be the way into the next place.
    if (role === d.kind || (d.kind === 'prop' && role === 'exit')) return [];
    return [`"${d.key}" was drawn as ${d.kind === 'item' ? 'an item' : `a ${d.kind}`}: its role must be "${d.kind}"`];
  });
}

/** The drawings a place's painting follows: the place itself first, then what was drawn of the props and items in it (three at most). */
export function drawingsIn(files: WorldFiles, place: Place): Array<{ key: string; image: Buffer }> {
  const keys = [place.key, ...place.things.filter((t) => t.role !== 'npc').map((t) => t.key)];
  return keys.flatMap((key) => {
    const image = drawingFor(files, key);
    return image ? [{ key, image }] : [];
  }).slice(0, 3);
}
