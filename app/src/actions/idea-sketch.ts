import { STYLE_REFERENCE_PROMPT, worldStyleReference } from '../world/style-reference.ts';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { Memo, inputHash } from '../meta/memo.ts';
import { musePaint, museEdit } from '../meta/muse.ts';
import { designInitialWorld } from '../commands/world.ts';
import { normalisePhoto } from '../scene/photo.ts';
import { drawingFor, drawingsIn, PICTURE } from '../world/drawings.ts';
import { CreativeChoices, refinedIdea } from '../world/idea-review.ts';
import { MAX_WORLD_PHOTOS } from '../world/photo-limits.ts';
import { SketchId, sketchFiles, sketchFingerprint, sketchAssets, assetId, sketchImagePath, type SketchRecord } from '../world/sketch.ts';
import { VideoId, videoDir, videoState, VIDEO_STEP } from '../world/video.ts';
import { Slug } from '../world/schema.ts';
import { ActionError, defineAction } from './registry.ts';
import { seedIdea, shapeIdea } from './start.ts';

const pending = new Map<string, Promise<unknown>>();
async function once<T>(key: string, run: () => Promise<T>): Promise<T> {
  if (pending.has(key)) return pending.get(key) as Promise<T>;
  const task = run(); pending.set(key, task);
  try { return await task; } finally { if (pending.get(key) === task) pending.delete(key); }
}

defineAction({
  name: 'idea_sketch',
  description: 'Plan the exact cast and places for visual approval before building. Reuses the normal world design stage; does not generate gameplay, models, audio or start a build.',
  input: z.object({ idea: z.string().min(10).max(4000), choices: CreativeChoices.optional(), places: z.number().int().min(1).max(8).optional(), language: z.string().min(2).max(30).optional(), photos: z.array(z.object({ name: z.string().min(1).max(120), data: z.string().min(10) })).max(MAX_WORLD_PHOTOS).default([]), videos: z.array(VideoId).max(8).default([]) }),
  async run(input, ctx) {
    const fingerprint = sketchFingerprint(input);
    let id = fingerprint, files = sketchFiles(ctx.root, id), copy: typeof files | undefined, edition = 0;
    // A repeated HTTP approval is idempotent; a new visit after publication can build a new world.
    // Reuse its paid plan and pictures instead of asking the models again.
    while (fs.existsSync(files.path('sketch.json')) && (files.readJson(files.path('sketch.json')) as SketchRecord).publication) {
      copy = files; id = inputHash(fingerprint, String(++edition)); files = sketchFiles(ctx.root, id);
    }
    return once(files.dir, async () => {
      for (const id of input.videos) {
        const dir = videoDir(ctx.root, id), state = videoState(dir);
        if (!state.duration || state.received !== state.size || Array.from({ length: Math.ceil(state.duration / VIDEO_STEP) }, (_, i) => i).some(i => !fs.existsSync(path.join(dir, `part-${i}.json`)))) throw new ActionError(409, 'Finish interpreting the video before previewing.');
      }
      if (!fs.existsSync(files.path('sketch.json')) && copy) {
        fs.cpSync(copy.dir, files.dir, { recursive: true });
        const record = files.readJson(files.path('sketch.json')) as SketchRecord;
        delete record.publication;
        files.write(files.path('sketch.json'), record);
      }
      if (!fs.existsSync(files.path('sketch.json'))) {
        for (const p of input.photos) if (!PICTURE.test(p.name)) throw new ActionError(400, `${p.name}: a photo is png, jpg, webp or heic`);
        const images = await Promise.all(input.photos.map(p => normalisePhoto(Buffer.from(p.data.replace(/^data:[^,]*,/, ''), 'base64'))));
        const brief = refinedIdea(input.idea, input.choices);
        const shape = await shapeIdea(new Memo(path.join(ctx.root, '.start', 'memo')), brief, images);
        const seeded = seedIdea(files.dir, input.idea, input.choices, input.photos, images, shape, ctx.root);
        await designInitialWorld(files, { places: input.places ?? shape.places, language: input.language ?? shape.language, given: brief, ...seeded });
        files.write(files.path('sketch.json'), { fingerprint, slug: shape.slug, worldHash: inputHash(fs.readFileSync(files.path('world.json'))) } satisfies SketchRecord);
      }
      const world = files.world();
      return { id, title: world.title, pitch: world.pitch, assets: sketchAssets(world) };
    });
  },
});

defineAction({
  name: 'idea_sketch_image',
  description: 'Paint one reusable concept for a planned character or place. Take 0 is the first preview; a new take is generated only when requested. No animation, cutout, model or audio work.',
  input: z.object({ id: SketchId, kind: z.enum(['character', 'place']), key: Slug, take: z.number().int().min(0).max(9).default(0), baseTake: z.number().int().min(0).max(9).optional(), change: z.string().trim().max(1200).default(''), reference: z.object({ name: z.string().min(1).max(120), data: z.string().min(10).max(8_000_000) }).optional() }),
  async run({ id, kind, key, take, baseTake, change, reference }, ctx) {
    const files = sketchFiles(ctx.root, id), world = files.world();
    const asset = sketchAssets(world).find(a => a.kind === kind && a.key === key);
    if (!asset) throw new ActionError(404, 'This character or place is not in the preview.');
    if (baseTake !== undefined && (baseTake >= take || !fs.existsSync(sketchImagePath(files, asset, baseTake)))) throw new ActionError(400, 'Choose an existing earlier preview to revise.');
    if ((change || reference) && baseTake === undefined) throw new ActionError(400, 'Choose a preview before describing changes.');
    // Reserve the meaning of a take before joining its in-flight call. Conflicting edits must
    // never silently reuse somebody else's paid image, including after a failed generation.
    const file = sketchImagePath(files, asset, take), requestFile = file + '.request.json';
    const fingerprint = inputHash(JSON.stringify({ baseTake: baseTake ?? null, change, reference: reference ?? null }));
    if (fs.existsSync(requestFile)) {
      if ((files.readJson(requestFile) as { fingerprint: string }).fingerprint !== fingerprint) throw new ActionError(409, 'This version already has different instructions. Create another version.');
    } else {
      if (fs.existsSync(file) && (baseTake !== undefined || change || reference)) throw new ActionError(409, 'This version already exists. Create another version.');
      files.write(requestFile, { fingerprint, baseTake, change });
    }
    return once(`${files.dir}:${assetId(asset)}:${take}`, async () => {
      if (!fs.existsSync(file)) {
        const references: Buffer[] = [];
        if (kind === 'character') {
          const drawn = drawingFor(files, key), photo = files.path('cast', `${key}-photo.png`);
          if (drawn) references.push(drawn);
          if (fs.existsSync(photo)) references.push(fs.readFileSync(photo));
        } else {
          references.push(...drawingsIn(files, world.places.find(p => p.key === key)!).map(d => d.image));
          const photo = files.place(key, 'photo.png');
          if (fs.existsSync(photo)) references.unshift(fs.readFileSync(photo));
        }
        const styleImage = worldStyleReference(files, world.style);
        if (styleImage) references.push(styleImage);
        const styleIndex = styleImage ? references.length : 0;
        if (baseTake !== undefined) references.push(fs.readFileSync(sketchImagePath(files, asset, baseTake)));
        if (reference) {
          const added = await normalisePhoto(Buffer.from(reference.data.replace(/^data:[^,]*,/, ''), 'base64'));
          files.write(file + '.reference.png', added);
          references.push(added);
        }
        const prompt = `A clear visual concept for an adventure game, to let its creator approve the appearance before production.
${kind === 'character' ? 'Show one full-body character, head to feet or paws, in a walking-ready pose on a quiet plain background. No other characters.' : 'Show this place as a wide stage for a point-and-click game, with clear open walking space, no people. Include these important objects: ' + world.places.find(p => p.key === key)!.things.filter(t => t.role !== 'npc').map(t => t.looks).join('; ')}
Subject: ${asset.looks}
Style: ${world.style}
${styleImage ? `Image ${styleIndex}: ${STYLE_REFERENCE_PROMPT}` : ''}
Preserve the identity, distinctive shapes, colours and proportions of any original reference drawings or photos. Keep the entire subject in frame. Simple readable composition, no text, labels, watermarks, panels or interface. This image will be the approved appearance reference for the finished game.
${baseTake === undefined ? '' : `Revise the ${reference ? 'second-to-last' : 'last'} reference image: it is the creator's selected current version. Keep everything not explicitly changed, including its character identity and world style. ${change ? `Creator's visual direction: ${change}` : 'Explore a fresh visual variation of this version.'}`}
${reference ? 'The last image is an additional reference supplied for this revision. Use its relevant visual details according to the creator\'s direction; it does not replace the whole world style or story.' : ''}`;
        const args = { label: `concept:${kind}:${key}`, prompt, take };
        const image = references.length ? await museEdit(files.memo, { ...args, images: references }) : await musePaint(files.memo, args);
        files.write(file, await sharp(image).png().toBuffer());
      }
      const image = await sharp(file).resize(480, 360, { fit: 'contain', background: '#faf6ee' }).jpeg({ quality: 85 }).toBuffer();
      const large = await sharp(file).resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
      const used = Array.from({ length: 10 }, (_, i) => i).filter(i => fs.existsSync(sketchImagePath(files, asset, i)) || fs.existsSync(sketchImagePath(files, asset, i) + '.request.json'));
      return { image: `data:image/jpeg;base64,${image.toString('base64')}`, largeImage: `data:image/jpeg;base64,${large.toString('base64')}`, take, nextTake: Math.max(...used) + 1 };
    });
  },
});
