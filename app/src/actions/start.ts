// A new world from one idea: Spark reads it (and any photos) and picks the world's name, how many places the
// story needs and the language it is told in, so the person writes the idea and nothing else. A spoken idea is heard here too.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Memo } from '../meta/memo.ts';
import { askSparkJson } from '../meta/spark.ts';
import { transcribe } from '../meta/voice.ts';
import { normalisePhoto } from '../scene/photo.ts';
import { decode } from '../sound/pcm.ts';
import { pcm24k } from '../sound/voices.ts';
import { PICTURE } from '../world/drawings.ts';
import { pieces, SOUND } from '../world/told.ts';
import { Slug } from '../world/schema.ts';
import { ActionError, defineAction } from './registry.ts';

/** Calls made before a world has a folder are remembered here (a dot folder, so it is never listed as a world). */
const startMemo = (root: string) => new Memo(path.join(root, '.start', 'memo'));

const Shape = z.object({
  title: z.string().min(1).max(80),
  slug: z.string().min(2).max(40),
  places: z.number().int().min(2).max(5),
  language: z.string().min(2).max(30),
  pictures: z.array(z.enum(['place', 'hero', 'drawing', 'none'])).optional(),
});
type Shape = z.infer<typeof Shape>;

/** One Spark call: what the idea is called, how many places it needs to be told, its language, and what each photo is. */
export async function shapeIdea(memo: Memo, idea: string, photos: Buffer[]): Promise<Shape> {
  const prompt = `Someone wants a short 2D point-and-click adventure game made from this idea:
"""${idea}"""
${photos.length ? `\nThey added ${photos.length} photo${photos.length > 1 ? 's' : ''} (in order). For each say what it is for: "place" when it is a photo of a real room or spot that should become the first place of the game, "hero" when it is a photo of a real person who should be the hero, "drawing" when it is a drawing (a child's or anyone's, on paper or a screen) of a character, a thing or a place for the game, "none" otherwise. At most one "place" and one "hero"; any number of drawings.\n` : ''}
Decide:
- title: a short, evocative title for the game, in the language the idea is written in.
- slug: a short name for its folder: 1 to 3 English words in lowercase-kebab, like "last-foghorn" or "lantern-market".
- places: how many places the story needs, 2 to 5. Make only what the story needs: one scene or one room with a small task is 2; a usual small story with a goal is 3; a journey or a story that names more places is 4 or 5. If the idea names a number of places, use it.
- language: the language the idea is written in, in English ("English", "Polish").

Reply with JSON only: {"title": "...", "slug": "...", "places": 3, "language": "English"${photos.length ? ', "pictures": ["place"]' : ''}}`;
  return Shape.parse(await askSparkJson(memo, { label: 'idea-shape', prompt, images: photos }));
}

/** The slug cleaned to a folder name, numbered when a world has it already. */
function freeSlug(root: string, wanted: string): string {
  const base = wanted.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'world';
  let slug = base, n = 2;
  while (fs.existsSync(path.join(root, slug))) slug = `${base}-${n++}`;
  return slug;
}

const bytesOf = (data: string) => Buffer.from(data.replace(/^data:[^,]*,/, ''), 'base64');

defineAction({
  name: 'world_new',
  description: 'Make a new world from an idea and build it: Spark picks its title, folder name, how many places the story needs (2 to 5) and its language, '
    + 'unless given; photos (optional) of a real room become the first place, of a person the hero, and drawings the characters, things and places they show. Starts the world_build job and returns the slug.',
  input: z.object({
    idea: z.string().min(10).max(4000),
    slug: Slug.optional().describe('the folder name; picked from the idea when left out'),
    places: z.number().int().min(1).max(8).optional().describe('picked from the idea when left out'),
    language: z.string().min(2).max(30).optional().describe('the game\'s language ("Polish"); read from the idea when left out'),
    photos: z.array(z.object({ name: z.string().min(1).max(120), data: z.string().min(10) })).max(16).optional().describe('photos, base64: a real room becomes the first place, a person the hero, drawings the characters, things and places they show'),
  }),
  job: true,
  async run({ idea, slug, places, language, photos = [] }, ctx) {
    for (const p of photos) if (!PICTURE.test(p.name)) throw new ActionError(400, `${p.name}: a photo is png, jpg, webp or heic`);
    const images = await Promise.all(photos.map((p) => normalisePhoto(bytesOf(p.data))));
    const shape = await shapeIdea(startMemo(ctx.root), idea.trim(), images);
    if (slug && fs.existsSync(path.join(ctx.root, slug, 'world.json'))) throw new ActionError(409, `${slug} is built already: pick another name`);
    const name = slug ?? freeSlug(ctx.root, shape.slug);
    const dir = path.join(ctx.root, name);
    // Photos go with the world, and the build reads them from there.
    const kept = (role: 'place' | 'hero') => {
      const at = (shape.pictures ?? []).indexOf(role);
      if (at < 0 || !images[at]) return [];
      const file = path.join(dir, 'start', `${role}.png`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, images[at]);
      return [role === 'place' ? '--photo' : '--hero-photo', file];
    };
    // Drawings are kept with the world; the world step reads each one (what it shows, who leads) and the game is drawn after them.
    const drawings = (shape.pictures ?? []).flatMap((role, i) => (role === 'drawing' && images[i] ? [i] : []));
    drawings.forEach((i, n) => {
      const file = path.join(dir, 'drawings', `${String(n + 1).padStart(2, '0')}-${photos[i].name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'drawing'}.png`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, images[i]);
    });
    const lang = language ?? shape.language;
    const args = ['build', name, idea.trim(), '--from', 'world', '--places', String(places ?? shape.places), ...(/^english$/i.test(lang) ? [] : ['--language', lang]), ...kept('place'), ...kept('hero')];
    const job = await ctx.jobs.start(name, args, 'build world > verify', ctx.by);
    return { slug: name, title: shape.title, places: places ?? shape.places, language: lang, drawings: drawings.length, job };
  },
});

defineAction({
  name: 'idea_hear',
  description: 'Hear a spoken idea (a recording, base64) and return it as text, in the language it was said (Muse Voice Transcribe).',
  input: z.object({ name: z.string().min(1).max(120), data: z.string().min(10) }),
  async run({ name, data }, ctx) {
    if (!SOUND.test(name)) throw new ActionError(400, `${name}: a recording is webm, m4a, mp3, wav or ogg`);
    const audio = decode(bytesOf(data));
    const said: string[] = [];
    for (const [i, piece] of pieces(pcm24k(audio)).entries()) said.push(await transcribe(startMemo(ctx.root), `idea:${i}`, piece, 8));
    return { text: said.join(' ').replace(/\s+/g, ' ').trim() };
  },
});
