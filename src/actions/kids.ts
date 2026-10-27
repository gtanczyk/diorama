// A workshop with children: photos of their drawings and recordings of them telling the story, kept with a
// world that does not exist yet (drawings/, told/), heard at once, and turned into the idea the world is built from.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { drawingFiles, keptName, Kind, normaliseDrawing, PICTURE, readDrawings, readDrawn, readKinds } from '../world/drawings.ts';
import { WorldFiles } from '../world/files.ts';
import { Slug } from '../world/schema.ts';
import { hear, hearAll, Idea, ideaFromTold, SOUND, toldFiles } from '../world/told.ts';
import { ActionError, defineAction } from './registry.ts';

const stamp = (file: string) => Math.round(fs.statSync(file).mtimeMs);

function readIdea(files: WorldFiles): Idea | null {
  const parsed = Idea.safeParse(fs.existsSync(files.path('told', 'idea.json')) ? JSON.parse(fs.readFileSync(files.path('told', 'idea.json'), 'utf8')) : null);
  return parsed.success ? parsed.data : null;
}

function status(files: WorldFiles) {
  const drawn = readDrawn(files);
  return {
    drawings: drawingFiles(files).map((file) => ({ file: `drawings/${file}`, v: stamp(files.path('drawings', file)), drawn: drawn.find((d) => d.file === file) ?? null })),
    told: toldFiles(files).map((clip) => {
      const text = files.path('told', clip.replace(/\.[^.]+$/, '.txt'));
      return { clip, file: `told/${clip}`, text: fs.existsSync(text) ? fs.readFileSync(text, 'utf8').trim() : null };
    }),
    idea: readIdea(files),
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
      const file = `${String(drawingFiles(files).length + 1).padStart(2, '0')}-${keptName(name)}.png`;
      files.write(files.path('drawings', file), await normaliseDrawing(bytes));
      return { file: `drawings/${file}` };
    }
    if (!SOUND.test(name)) throw new ActionError(400, `${name}: a recording is webm, m4a, mp3, wav or ogg`);
    const clip = `${String(toldFiles(files).length + 1).padStart(2, '0')}-${keptName(name)}${path.extname(name).toLowerCase()}`;
    files.write(files.path('told', clip), bytes);
    return { clip, text: await hear(files, clip) };
  },
});

defineAction({
  name: 'kids_remove',
  description: 'Take a drawing or a recording out of a workshop world (the file as kids_status lists it, drawings/… or told/…).',
  input: z.object({ slug: Slug, file: z.string().regex(/^(drawings|told)\/[a-z0-9-]+\.[a-z0-9]+$/) }),
  async run({ slug, file }, ctx) {
    const files = new WorldFiles(slug, ctx.root);
    const full = files.path(file);
    if (!fs.existsSync(full)) throw new ActionError(404, `${slug} has no ${file}`);
    fs.rmSync(full);
    fs.rmSync(full.replace(/\.[^.]+$/, '.txt'), { force: true });
    return status(files);
  },
});

defineAction({
  name: 'kids_idea',
  description: 'Write the idea of a workshop world from everything the children said and drew: Spark reads each drawing (hero, npc, item, prop or place) and joins what they told into one short story in their language. '
    + 'The idea can be edited before world_build.',
  input: z.object({ slug: Slug, note: z.string().max(2000).optional().describe('what the grown-up adds or wants') }),
  async run({ slug, note }, ctx) {
    const files = new WorldFiles(slug, ctx.root);
    const said = await hearAll(files);
    if (said.length === 0 && drawingFiles(files).length === 0) throw new ActionError(400, 'record the children telling their story or add a drawing first');
    const drawn = await readDrawings(files.memo, files, said.map((s) => s.text).join('\n'));
    if (drawn.length) files.write(files.path('drawings.json'), drawn);
    const idea = await ideaFromTold(files.memo, said.map((s) => s.text), drawn, note ?? '');
    files.write(files.path('told', 'idea.json'), idea);
    return status(files);
  },
});

defineAction({
  name: 'kids_kind',
  description: 'Say what a drawing is in the game (hero, npc, item, prop or place), over what Spark saw; kind null gives the choice back to Spark. Write the idea again (kids_idea) afterwards.',
  input: z.object({ slug: Slug, file: z.string().regex(/^drawings\/[a-z0-9-]+\.png$/), kind: Kind.nullable() }),
  async run({ slug, file, kind }, ctx) {
    const files = new WorldFiles(slug, ctx.root);
    const name = file.slice('drawings/'.length);
    if (!fs.existsSync(files.path(file))) throw new ActionError(404, `${slug} has no ${file}`);
    const kinds = readKinds(files);
    if (kind) kinds[name] = kind;
    else delete kinds[name];
    files.write(files.path('drawings', 'kinds.json'), kinds);
    // Shown at once; the next kids_idea reads every drawing again with it.
    const drawn = readDrawn(files);
    const entry = drawn.find((d) => d.file === name);
    if (entry && kind) {
      if (kind === 'hero') for (const d of drawn) if (d.kind === 'hero') d.kind = 'npc';
      entry.kind = kind;
      files.write(files.path('drawings.json'), drawn);
    }
    return status(files);
  },
});
