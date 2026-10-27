// A workshop with children: photos of their drawings and recordings of them telling the story, kept with a
// world that does not exist yet (drawings/, told/), heard at once, and turned into the idea the world is built from.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { previewDrawing } from '../scene/preview.ts';
import { drawingFiles, keptName, Kind, normaliseDrawing, oneHero, PICTURE, readDrawing, readDrawings, readDrawn, readKinds } from '../world/drawings.ts';
import { WorldFiles } from '../world/files.ts';
import { Slug } from '../world/schema.ts';
import { hear, hearAll, Idea, ideaFromTold, narrate, SOUND, toldFiles } from '../world/told.ts';
import { ActionError, defineAction } from './registry.ts';

/** One change at a time per world: photos arrive together, and each takes the next number and joins drawings.json. */
const queues = new Map<string, Promise<unknown>>();
function serial<T>(slug: string, run: () => Promise<T>): Promise<T> {
  const next = (queues.get(slug) ?? Promise.resolve()).catch(() => {}).then(run);
  queues.set(slug, next);
  return next;
}

const stamp = (file: string) => Math.round(fs.statSync(file).mtimeMs);

function readIdea(files: WorldFiles): Idea | null {
  const parsed = Idea.safeParse(fs.existsSync(files.path('told', 'idea.json')) ? JSON.parse(fs.readFileSync(files.path('told', 'idea.json'), 'utf8')) : null);
  return parsed.success ? parsed.data : null;
}

function status(files: WorldFiles) {
  const drawn = readDrawn(files);
  return {
    drawings: drawingFiles(files).map((file) => {
      const preview = files.path('drawings', 'preview', file);
      return { file: `drawings/${file}`, v: stamp(files.path('drawings', file)), drawn: drawn.find((d) => d.file === file) ?? null, preview: fs.existsSync(preview) ? { file: `drawings/preview/${file}`, v: stamp(preview) } : null };
    }),
    told: toldFiles(files).map((clip) => {
      const text = files.path('told', clip.replace(/\.[^.]+$/, '.txt'));
      return { clip, file: `told/${clip}`, text: fs.existsSync(text) ? fs.readFileSync(text, 'utf8').trim() : null };
    }),
    idea: readIdea(files),
    reading: fs.existsSync(files.path('idea.mp3')) ? { file: 'idea.mp3', v: stamp(files.path('idea.mp3')) } : null,
    built: fs.existsSync(files.path('world.json')),
  };
}

defineAction({
  name: 'kids_status',
  reads: true,
  description: 'A workshop world\'s material: the photos of children\'s drawings (and what each became), the recordings of them telling the story with what was heard, and the idea written from them.',
  input: z.object({ slug: Slug }),
  async run({ slug }, ctx) {
    return status(new WorldFiles(slug, ctx.root));
  },
});

defineAction({
  name: 'kids_add',
  description: 'Keep a photo of a child\'s drawing (kind drawing) or a recording of children telling their story (kind told) with a world, even before it is built. A recording is heard at once (Muse Voice Transcribe) and its text returned.',
  input: z.object({
    slug: Slug,
    kind: z.enum(['drawing', 'told']),
    name: z.string().min(1).max(120).describe('the file name, for its extension'),
    data: z.string().min(10).describe('the file, base64'),
  }),
  async run({ slug, kind, name, data }, ctx) {
    const files = new WorldFiles(slug, ctx.root);
    const bytes = Buffer.from(data.replace(/^data:[^,]*,/, ''), 'base64');
    if (kind === 'drawing') {
      if (!PICTURE.test(name)) throw new ActionError(400, `${name}: a drawing is a photo (png, jpg, webp, heic)`);
      const image = await normaliseDrawing(bytes);
      const file = await serial(slug, async () => {
        const file = `${String(drawingFiles(files).length + 1).padStart(2, '0')}-${keptName(name)}.png`;
        files.write(files.path('drawings', file), image);
        return file;
      });
      // Read at once (what it is, its key, how it looks), so its preview can start while the next one is drawn.
      const drawn = await readDrawing(files.memo, image, file, [...new Set(readDrawn(files).map((d) => d.key))]);
      await serial(slug, async () => {
        const kind = readKinds(files)[file];
        files.write(files.path('drawings.json'), oneHero([...readDrawn(files).filter((d) => d.file !== file), { ...drawn, ...(kind && { kind }) }], kind === 'hero' ? drawn.key : undefined));
      });
      return { file: `drawings/${file}`, drawn };
    }
    if (!SOUND.test(name)) throw new ActionError(400, `${name}: a recording is webm, m4a, mp3, wav or ogg`);
    const clip = await serial(slug, async () => {
      const clip = `${String(toldFiles(files).length + 1).padStart(2, '0')}-${keptName(name)}${path.extname(name).toLowerCase()}`;
      files.write(files.path('told', clip), bytes);
      return clip;
    });
    return { clip, text: await hear(files, clip) };
  },
});

defineAction({
  name: 'kids_remove',
  description: 'Take a drawing or a recording out of a workshop world (the file as kids_status lists it, drawings/… or told/…).',
  input: z.object({ slug: Slug, file: z.string().regex(/^(drawings|told)\/[a-z0-9-]+\.[a-z0-9]+$/) }),
  async run({ slug, file }, ctx) {
    return serial(slug, async () => remove(new WorldFiles(slug, ctx.root), file));
  },
});

function remove(files: WorldFiles, file: string) {
  const full = files.path(file);
    if (!fs.existsSync(full)) throw new ActionError(404, `${files.slug} has no ${file}`);
  fs.rmSync(full);
  fs.rmSync(full.replace(/\.[^.]+$/, '.txt'), { force: true });
  if (file.startsWith('drawings/')) {
    const name = file.slice('drawings/'.length);
    fs.rmSync(files.path('drawings', 'preview', name), { force: true });
    if (fs.existsSync(files.path('drawings.json'))) files.write(files.path('drawings.json'), oneHero(readDrawn(files).filter((d) => d.file !== name)));
  }
  return status(files);
}

defineAction({
  name: 'kids_idea',
  description: 'Write the idea of a workshop world from everything the children said and drew: Spark joins what they told and drew into one short story in their language, says which drawn character is the hero, and a storyteller voice reads it aloud (idea.mp3). '
    + 'The idea can be edited before world_build.',
  input: z.object({ slug: Slug, note: z.string().max(2000).optional().describe('what the grown-up adds or wants'), read: z.boolean().optional().describe('read it aloud (idea.mp3); default true') }),
  async run({ slug, note, read }, ctx) {
    const files = new WorldFiles(slug, ctx.root);
    const said = await hearAll(files);
    if (said.length === 0 && drawingFiles(files).length === 0) throw new ActionError(400, 'record the children telling their story or add a drawing first');
    const drawn = await readDrawings(files.memo, files);
    const idea = await ideaFromTold(files.memo, said.map((s) => s.text), drawn, note ?? '');
    // The story says who leads, unless the grown-up picked the hero.
    if (idea.hero && !Object.values(readKinds(files)).includes('hero')) oneHero(drawn, idea.hero);
    await serial(slug, async () => {
      if (drawn.length) files.write(files.path('drawings.json'), drawn);
      files.write(files.path('told', 'idea.json'), idea);
    });
    // Read aloud straight away; a story without a voice still stands.
    if (read !== false) await narrate(files, idea).catch((e: Error) => console.log(`no reading of the story: ${e.message}`));
    return status(files);
  },
});

defineAction({
  name: 'kids_kind',
  description: 'Say what a drawing is in the game (hero, npc, item, prop or place), over what Spark saw; kind null gives the choice back to Spark. A changed character is painted again by kids_preview; write the idea again (kids_idea) afterwards.',
  input: z.object({ slug: Slug, file: z.string().regex(/^drawings\/[a-z0-9-]+\.png$/), kind: Kind.nullable() }),
  async run({ slug, file, kind }, ctx) {
    return serial(slug, () => setKind(new WorldFiles(slug, ctx.root), file, kind));
  },
});

async function setKind(files: WorldFiles, file: string, kind: Kind | null) {
  const name = file.slice('drawings/'.length);
  if (!fs.existsSync(files.path(file))) throw new ActionError(404, `${files.slug} has no ${file}`);
  const kinds = readKinds(files);
  if (kind) kinds[name] = kind;
  else delete kinds[name];
  files.write(files.path('drawings', 'kinds.json'), kinds);
  // Shown at once; the next kids_idea writes the story with it.
  const drawn = readDrawn(files);
  const entry = drawn.find((d) => d.file === name);
  if (entry && kind) {
    entry.kind = kind;
    files.write(files.path('drawings.json'), kind === 'hero' || kind === 'npc' ? oneHero(drawn, kind === 'hero' ? entry.key : drawn.find((d) => d.kind === 'hero' && d !== entry)?.key) : drawn);
  }
  return status(files);
}

defineAction({
  name: 'kids_preview',
  description: 'Bring one drawing to life at once (about half a minute): a character as the figure the game will use, a place or a thing as a quick painting (drawings/preview/<file>). For the children to see while the rest is drawn.',
  input: z.object({ slug: Slug, file: z.string().regex(/^drawings\/[a-z0-9-]+\.png$/) }),
  async run({ slug, file }, ctx) {
    const files = new WorldFiles(slug, ctx.root);
    const name = file.slice('drawings/'.length);
    const drawn = readDrawn(files).find((d) => d.file === name);
    if (!drawn) throw new ActionError(404, `${file} is not read yet: add it with kids_add`);
    files.write(files.path('drawings', 'preview', name), await previewDrawing(files.memo, drawn, fs.readFileSync(files.path(file))));
    return status(files);
  },
});
