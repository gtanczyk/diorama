import { styleReferencePath } from '../src/world/style-reference.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
vi.mock('../src/meta/spark.ts', () => ({ askSparkJson: vi.fn() }));
vi.mock('../src/meta/muse.ts', () => ({ musePaint: vi.fn(), museEdit: vi.fn() }));
vi.mock('../src/commands/world.ts', () => ({ designInitialWorld: vi.fn() }));
import '../src/actions/idea-sketch.ts';
import { askSparkJson } from '../src/meta/spark.ts';
import { musePaint, museEdit } from '../src/meta/muse.ts';
import { designInitialWorld } from '../src/commands/world.ts';
import { runAction, type ActionContext } from '../src/actions/registry.ts';
import { Events } from '../src/studio/events.ts';
import { assetId, approvedConcept, sketchFiles, type Sketch } from '../src/world/sketch.ts';
import { WorldFiles } from '../src/world/files.ts';
import type { World } from '../src/world/schema.ts';

const world: World = { title: 'Smocza poczta', pitch: 'Smok doręcza list przyjaciółce.', style: 'Black pencil on cream paper', start: 'home', language: 'Polish', hero: { key: 'dragon', looks: 'A tiny white dragon with one wing' }, names: { dragon: 'Smok', owl: 'Sowa', home: 'Domek' }, places: [{ key: 'home', shows: 'A little wooden house with a round door', mood: 'sunny', things: [{ key: 'owl', role: 'npc', looks: 'A white owl with huge eyes' }], exits: [] }] };
const input = { idea: 'Smok doręcza list przyjaciółce.', places: 1, choices: { answers: [{ question: 'Kim grasz?', answer: 'Smokiem' }], style: world.style } };
let root: string, ctx: ActionContext, png: Buffer;
const start = vi.fn();
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-sketch-'));
  ctx = { root, by: 'user', jobs: { start }, events: new Events() } as unknown as ActionContext;
  start.mockReset().mockResolvedValue({ id: 'build-one' });
  vi.mocked(askSparkJson).mockReset().mockResolvedValue({ title: world.title, slug: 'dragon-post', places: 2, language: 'Polish' });
  vi.mocked(designInitialWorld).mockReset().mockImplementation(async files => { files.write(files.path('world.json'), world); });
  png = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#bb9988' } }).png().toBuffer();
  vi.mocked(musePaint).mockReset().mockResolvedValue(png); vi.mocked(museEdit).mockReset().mockResolvedValue(png);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const plan = () => runAction('idea_sketch', input, ctx) as Promise<Sketch>;
async function paint(sketch: Sketch, take = 0) {
  for (const asset of sketch.assets) await runAction('idea_sketch_image', { id: sketch.id, kind: asset.kind, key: asset.key, take }, ctx);
  return Object.fromEntries(sketch.assets.map(a => [assetId(a), take]));
}

test('preview reuses one normal world plan, with all characters and places, without starting production', async () => {
  const [a, b] = await Promise.all([plan(), plan()]);
  expect(a).toEqual(b); expect(a.assets.map(a => [assetId(a), a.role, a.label])).toEqual([['character:dragon', 'hero', 'Smok'], ['character:owl', 'npc', 'Sowa'], ['place:home', 'place', 'Domek']]);
  expect(designInitialWorld).toHaveBeenCalledTimes(1);
  expect(vi.mocked(designInitialWorld).mock.calls[0][1]).toMatchObject({ places: 1, language: 'Polish' });
  expect(start).not.toHaveBeenCalled(); expect(musePaint).not.toHaveBeenCalled();
  expect(fs.readdirSync(root)).toEqual(['.start']);
  expect(await plan()).toEqual(a); expect(designInitialWorld).toHaveBeenCalledTimes(1);
});

test('only requested cards are generated, originals are supplied, and paid takes are reused', async () => {
  const sketch = await plan(), files = sketchFiles(root, sketch.id);
  files.write(files.path('drawings', 'dragon.png'), png);
  files.write(files.path('drawings.json'), [{ file: 'dragon.png', key: 'dragon', kind: 'hero', looks: world.hero.looks }]);
  const request = { id: sketch.id, kind: 'character', key: 'dragon', take: 0 };
  const results = await Promise.all([runAction('idea_sketch_image', request, ctx), runAction('idea_sketch_image', request, ctx)]) as Array<{ image: string }>;
  expect(results[0]).toEqual(results[1]); expect(museEdit).toHaveBeenCalledTimes(1); expect(musePaint).not.toHaveBeenCalled();
  expect(vi.mocked(museEdit).mock.calls[0][1].images).toEqual([png]);
  await runAction('idea_sketch_image', request, ctx); expect(museEdit).toHaveBeenCalledTimes(1);
  await runAction('idea_sketch_image', { ...request, take: 1 }, ctx); expect(museEdit).toHaveBeenCalledTimes(2);
  expect(await sharp(Buffer.from(results[0].image.split(',')[1], 'base64')).metadata()).toMatchObject({ width: 480, height: 360 });
  await expect(runAction('idea_sketch_image', { ...request, key: 'invented' }, ctx)).rejects.toThrow('not in the preview');
  expect(start).not.toHaveBeenCalled();
});

test('approval preserves the exact world and selected images and begins at story; repeated approval does not duplicate a build', async () => {
  const sketch = await plan();
  const selections = await paint(sketch);
  const newPng = await sharp(png).tint('blue').png().toBuffer(); vi.mocked(musePaint).mockResolvedValue(newPng);
  await runAction('idea_sketch_image', { id: sketch.id, kind: 'character', key: 'dragon', take: 1 }, ctx);
  selections['character:dragon'] = 1;
  const body = { ...input, sketch: { id: sketch.id, selections } };
  const [first, second] = await Promise.all([runAction('world_new', body, ctx), runAction('world_new', body, ctx)]) as Array<{ slug: string }>;
  expect(second).toEqual(first); expect(start).toHaveBeenCalledTimes(1);
  expect(start.mock.calls[0][1]).toEqual(['build', first.slug, expect.stringContaining('Smokiem'), '--from', 'story']);
  const files = new WorldFiles(first.slug, root);
  expect(files.world()).toEqual(world);
  expect(approvedConcept(files, 'character', 'dragon')).toEqual(newPng);
  expect(approvedConcept(files, 'place', 'home')).toEqual(png);
  expect(fs.existsSync(files.path('concepts', 'character', 'dragon-0.png'))).toBe(true);
  expect(designInitialWorld).toHaveBeenCalledTimes(1);
  await expect(runAction('world_new', { ...body, sketch: { ...body.sketch, selections: { ...selections, 'character:dragon': 0 } } }, ctx)).rejects.toThrow('different selection');
  const nextVisit = await plan();
  expect(nextVisit.id).not.toBe(sketch.id);
  const next = await runAction('world_new', { ...input, sketch: { id: nextVisit.id, selections } }, ctx) as { slug: string };
  expect(next.slug).not.toBe(first.slug);
  expect(start).toHaveBeenCalledTimes(2);
  expect(designInitialWorld).toHaveBeenCalledTimes(1);
});

test('approval rejects changed briefs, unfinished cards and changed plans before creating a world', async () => {
  const sketch = await plan(), selections = Object.fromEntries(sketch.assets.map(a => [assetId(a), 0]));
  const body = { ...input, sketch: { id: sketch.id, selections } };
  await expect(runAction('world_new', { ...body, idea: 'An entirely different story' }, ctx)).rejects.toThrow('idea changed');
  await expect(runAction('world_new', { ...body, sketch: { id: sketch.id, selections: {} } }, ctx)).rejects.toThrow('every character');
  await expect(runAction('world_new', body, ctx)).rejects.toThrow('not ready yet');
  await paint(sketch);
  const files = sketchFiles(root, sketch.id); files.write(files.path('world.json'), { ...world, title: 'Changed title' });
  await expect(runAction('world_new', body, ctx)).rejects.toThrow('plan changed');
  expect(start).not.toHaveBeenCalled(); expect(fs.readdirSync(root)).toEqual(['.start']);
});

test('failed image calls can be retried without replanning or starting a build', async () => {
  const sketch = await plan(), body = { id: sketch.id, kind: 'place', key: 'home' };
  vi.mocked(musePaint).mockRejectedValueOnce(new Error('image outage'));
  await expect(runAction('idea_sketch_image', body, ctx)).rejects.toThrow('image outage');
  await expect(runAction('idea_sketch_image', body, ctx)).resolves.toHaveProperty('image');
  expect(designInitialWorld).toHaveBeenCalledTimes(1); expect(start).not.toHaveBeenCalled();
});

test('a directed revision edits the selected take plus an attached reference, keeps originals, and cannot be overwritten', async () => {
  const sketch = await plan(), files = sketchFiles(root, sketch.id);
  const target = { id: sketch.id, kind: 'character', key: 'dragon' };
  const first = await runAction('idea_sketch_image', target, ctx) as { largeImage: string; nextTake: number };
  expect(first.nextTake).toBe(1);
  expect(await sharp(Buffer.from(first.largeImage.split(',')[1], 'base64')).metadata()).toMatchObject({ width: 40, height: 40 });
  const reference = await sharp(png).tint('red').png().toBuffer();
  const edited = await sharp(png).tint('blue').png().toBuffer();
  vi.mocked(museEdit).mockResolvedValue(edited);
  const request = { ...target, take: 1, baseTake: 0, change: 'Większe skrzydła, zachowaj pyszczek.', reference: { name: 'wings.png', data: reference.toString('base64') } };
  const [a, b] = await Promise.all([runAction('idea_sketch_image', request, ctx), runAction('idea_sketch_image', request, ctx)]);
  expect(a).toEqual(b); expect(a).toHaveProperty('nextTake', 2);
  expect(museEdit).toHaveBeenCalledTimes(1);
  const args = vi.mocked(museEdit).mock.calls[0][1];
  expect(args.prompt).toContain(request.change); expect(args.prompt).toContain('second-to-last');
  expect(args.images).toEqual([png, expect.any(Buffer)]);
  expect(await sharp(args.images[1]).raw().toBuffer()).toEqual(await sharp(reference).raw().toBuffer());
  expect(fs.readFileSync(files.path('concepts', 'character', 'dragon-0.png'))).toEqual(png);
  expect(fs.readFileSync(files.path('concepts', 'character', 'dragon-1.png'))).toEqual(edited);
  expect(fs.existsSync(files.path('concepts', 'character', 'dragon-1.png.reference.png'))).toBe(true);
  await expect(runAction('idea_sketch_image', { ...request, change: 'Inny smok' }, ctx)).rejects.toThrow('different instructions');
  await expect(runAction('idea_sketch_image', { ...target, take: 2, baseTake: 8, change: 'Wings' }, ctx)).rejects.toThrow('earlier preview');
  await expect(runAction('idea_sketch_image', { ...target, take: 2, change: 'Wings' }, ctx)).rejects.toThrow('Choose a preview');
  const readOriginal = await runAction('idea_sketch_image', target, ctx) as { nextTake: number };
  expect(readOriginal.nextTake).toBe(2);
  expect(start).not.toHaveBeenCalled(); expect(designInitialWorld).toHaveBeenCalledTimes(1);
});

test('a failed revision retries its exact inputs and a concurrent conflicting request is rejected', async () => {
  const sketch = await plan(), target = { id: sketch.id, kind: 'place', key: 'home' };
  await runAction('idea_sketch_image', target, ctx);
  const request = { ...target, take: 1, baseTake: 0, change: 'A blue door' };
  vi.mocked(museEdit).mockRejectedValueOnce(new Error('temporary outage'));
  const results = await Promise.allSettled([
    runAction('idea_sketch_image', request, ctx),
    runAction('idea_sketch_image', { ...request, change: 'A red door' }, ctx),
  ]);
  expect(results[0]).toMatchObject({ status: 'rejected', reason: new Error('temporary outage') });
  expect(results[1].status).toBe('rejected');
  if (results[1].status === 'rejected') expect(results[1].reason.message).toContain('different instructions');
  await expect(runAction('idea_sketch_image', request, ctx)).resolves.toHaveProperty('image');
  expect(museEdit).toHaveBeenCalledTimes(2);
  expect(vi.mocked(museEdit).mock.calls[0][1]).toEqual(vi.mocked(museEdit).mock.calls[1][1]);
});


test('a chosen style reference survives planning and publication and guides preview assets', async () => {
  const id = 'e'.repeat(32), reference = styleReferencePath(root, id);
  fs.mkdirSync(path.dirname(reference), { recursive: true }); fs.writeFileSync(reference, png);
  const withStyle = { ...input, choices: { ...input.choices, styleReference: id } };
  const sketch = await runAction('idea_sketch', withStyle, ctx) as Sketch;
  const files = sketchFiles(root, sketch.id);
  expect(fs.readFileSync(files.path('style-reference.png'))).toEqual(png);
  const selections = await paint(sketch);
  expect(musePaint).not.toHaveBeenCalled();
  for (const [, args] of vi.mocked(museEdit).mock.calls) {
    expect(args.images).toEqual([png]); expect(args.prompt).toContain('STYLE reference only');
  }
  const built = await runAction('world_new', { ...withStyle, sketch: { id: sketch.id, selections } }, ctx) as { slug: string };
  expect(fs.readFileSync(path.join(root, built.slug, 'style-reference.png'))).toEqual(png);
});

test('expanding a preview preserves the old plan and paid concepts in a new connected draft', async () => {
  const sketch = await plan();
  const selections = await paint(sketch);
  const old = sketchFiles(root, sketch.id);
  const expanded: World = structuredClone(world);
  expanded.places[0].things.push({key:'arch',role:'exit',looks:'An old stone arch'}, {key:'fox',role:'npc',looks:'A friendly little fox'});
  expanded.places[0].exits.push({to:'garden',via:'arch'});
  expanded.places.push({key:'garden',shows:'A quiet garden filled with flowers',mood:'peaceful',things:[{key:'gate',role:'exit',looks:'A wooden garden gate'}],exits:[{to:'home',via:'gate'}]});
  expanded.names = {...expanded.names,fox:'Lis',garden:'Ogród'};
  vi.mocked(askSparkJson).mockResolvedValue(expanded);
  const revised = await runAction('idea_sketch_expand',{id:sketch.id,wish:'Dodaj lisa i ogród'},ctx) as Sketch;
  expect(revised.id).not.toBe(sketch.id);
  expect(revised.assets.map(assetId)).toContain('character:fox');
  expect(revised.assets.map(assetId)).toContain('place:garden');
  expect(old.world()).toEqual(world);
  const next=sketchFiles(root,revised.id);
  for (const asset of sketch.assets) expect(fs.readFileSync(next.path('concepts',asset.kind,`${asset.key}-${selections[assetId(asset)]}.png`))).toEqual(png);
  for (const asset of revised.assets.filter(a=>!sketch.assets.some(b=>assetId(a)===assetId(b)))) {
    await runAction('idea_sketch_image',{id:revised.id,kind:asset.kind,key:asset.key},ctx);
    selections[assetId(asset)]=0;
  }
  await runAction('world_new',{...input,sketch:{id:revised.id,selections}},ctx);
  expect(new WorldFiles('dragon-post',root).world()).toEqual(expanded);
  expect((await runAction('idea_sketch_expand',{id:sketch.id,wish:'Dodaj lisa i ogród'},ctx) as Sketch).id).toBe(revised.id);
});

test('expanding refuses to change previously approved characters', async()=>{
  const sketch=await plan(),changed=structuredClone(world);
  changed.hero.looks='A completely different purple dragon';
  vi.mocked(askSparkJson).mockResolvedValue(changed);
  await expect(runAction('idea_sketch_expand',{id:sketch.id,wish:'Dodaj kogoś'},ctx)).rejects.toThrow(/changed the existing hero/);
  expect(sketchFiles(root,sketch.id).world()).toEqual(world);
});
