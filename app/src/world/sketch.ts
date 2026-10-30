// A reviewed world plan is immutable. Only its selected visual takes vary before publication.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { inputHash } from '../meta/memo.ts';
import { ActionError, type ActionContext } from '../actions/registry.ts';
import { WorldFiles } from './files.ts';
import { type World, Slug } from './schema.ts';
import { type CreativeChoices, refinedIdea } from './idea-review.ts';
import { videoDir } from './video.ts';

export const SketchId = z.string().regex(/^[a-f0-9]{32}$/);
export const SketchApproval = z.object({ id: SketchId, selections: z.record(z.number().int().min(0).max(9)) });
export type SketchApproval = z.infer<typeof SketchApproval>;
export type SketchInput = { idea: string; choices?: CreativeChoices; photos?: Array<{ name: string; data: string }>; videos?: string[]; places?: number; language?: string; slug?: string };
export type SketchAsset = { key: string; kind: 'character' | 'place'; label: string; role: 'hero' | 'npc' | 'place'; looks: string };
export type Sketch = { id: string; title: string; pitch: string; assets: SketchAsset[] };
export type SketchRecord = { fingerprint: string; slug: string; worldHash: string; publication?: { slug: string; selections: string; result?: unknown } };
export const sketchFiles = (root: string, id: string) => new WorldFiles(SketchId.parse(id), path.join(root, '.start', 'sketches'));
export const sketchFingerprint = (input: SketchInput) => inputHash(JSON.stringify({ idea: input.idea, choices: input.choices ?? null, photos: input.photos ?? [], videos: input.videos ?? [], places: input.places ?? null, language: input.language ?? null }));

export function sketchAssets(world: World): SketchAsset[] {
  const people = [world.hero, ...world.places.flatMap(p => p.things.filter(t => t.role === 'npc'))];
  return [
    ...[...new Map(people.map(p => [p.key, p])).values()].map(p => ({ key: p.key, kind: 'character' as const, label: world.names?.[p.key] ?? p.key.replace(/-/g, ' '), role: p.key === world.hero.key ? 'hero' as const : 'npc' as const, looks: p.looks })),
    ...world.places.map(p => ({ key: p.key, kind: 'place' as const, label: world.names?.[p.key] ?? p.key.replace(/-/g, ' '), role: 'place' as const, looks: `${p.shows}. ${p.mood}` })),
  ];
}
export const assetId = (asset: Pick<SketchAsset, 'kind' | 'key'>) => `${asset.kind}:${asset.key}`;
export const sketchImagePath = (files: WorldFiles, asset: Pick<SketchAsset, 'kind' | 'key'>, take: number) => files.path('concepts', asset.kind, `${Slug.parse(asset.key)}-${take}.png`);

/** Clean, unwatermarked reference. The PREVIEW label belongs to the UI, never to the painting. */
export function approvedConcept(files: WorldFiles, kind: SketchAsset['kind'], key: string): Buffer | undefined {
  const file = files.path('concepts', kind, `${Slug.parse(key)}.png`);
  return fs.existsSync(file) ? fs.readFileSync(file) : undefined;
}

const publishing = new Map<string, Promise<unknown>>();
export async function publishSketch(ctx: ActionContext, input: SketchInput, approval: SketchApproval): Promise<unknown> {
  const files = sketchFiles(ctx.root, approval.id), lock = files.dir;
  // Serialize conflicting submissions as well as double clicks; only one world can own this approval.
  const previous = publishing.get(lock);
  if (previous) { await previous.catch(() => {}); return publishSketch(ctx, input, approval); }
  const task = (async () => {
    const record = files.readJson(files.path('sketch.json')) as SketchRecord;
    if (record.fingerprint !== sketchFingerprint(input)) throw new ActionError(409, 'Your idea changed. Preview it again before building this version.');
    const worldBytes = fs.readFileSync(files.path('world.json'));
    if (record.worldHash !== inputHash(worldBytes)) throw new ActionError(409, 'The world plan changed. Preview it again.');
    const world = files.world(), assets = sketchAssets(world);
    if (Object.keys(approval.selections).length !== assets.length || assets.some(a => !Number.isInteger(approval.selections[assetId(a)]))) throw new ActionError(409, 'Choose a preview for every character and place, or skip the preview.');
    for (const a of assets) if (!fs.existsSync(sketchImagePath(files, a, approval.selections[assetId(a)]))) throw new ActionError(409, `The preview for ${a.label} is not ready yet.`);
    const selectionHash = inputHash(JSON.stringify(assets.map(a => [assetId(a), approval.selections[assetId(a)]])));
    if (record.publication) {
      if (record.publication.selections !== selectionHash || input.slug && input.slug !== record.publication.slug) throw new ActionError(409, 'This preview has already been used to build a different selection.');
      if (record.publication.result) return record.publication.result;
    } else {
      const base = Slug.safeParse(input.slug ?? record.slug);
      let name = base.success ? base.data : 'my-world', n = 2;
      const first = name;
      if (input.slug && fs.existsSync(path.join(ctx.root, name))) throw new ActionError(409, `${name} already exists: pick another name`);
      while (fs.existsSync(path.join(ctx.root, name))) name = `${first}-${n++}`;
      const dest = new WorldFiles(`publish-${approval.id}`, path.join(ctx.root, '.start'));
      // Retain all paid concepts and source drawings, but never make the temporary folder a visible world.
      fs.cpSync(files.dir, dest.dir, { recursive: true });
      for (const a of assets) dest.write(dest.path('concepts', a.kind, `${a.key}.png`), fs.readFileSync(sketchImagePath(files, a, approval.selections[assetId(a)])));
      dest.write(dest.path('approved-sketch.json'), { ...approval, approvedAt: new Date().toISOString() });
      for (const id of input.videos ?? []) fs.cpSync(videoDir(ctx.root, id), dest.path('videos', id), { recursive: true });
      fs.renameSync(dest.dir, path.join(ctx.root, name));
      record.publication = { slug: name, selections: selectionHash };
      files.write(files.path('sketch.json'), record);
    }
    const name = record.publication.slug;
    const job = await ctx.jobs.start(name, ['build', name, refinedIdea(input.idea, input.choices), '--from', 'story'], 'build approved world > verify', ctx.by);
    const result = { slug: name, title: world.title, places: world.places.length, language: world.language ?? 'English', job };
    record.publication.result = result;
    files.write(files.path('sketch.json'), record);
    return result;
  })();
  publishing.set(lock, task);
  try { return await task; } finally { if (publishing.get(lock) === task) publishing.delete(lock); }
}
