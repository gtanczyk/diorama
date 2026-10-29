// One Studio job: plan and validate first, then build only the anchor and additions.
import fs from 'node:fs';
import { defineCommand, emit, registry } from '../registry.ts';
import { readDrawn } from '../world/drawings.ts';
import { designExtension } from '../world/extend.ts';
import { stagedExtension } from '../world/extend-stage.ts';
import { WorldFiles, withThingEdits } from '../world/files.ts';
import { World } from '../world/schema.ts';
import { Story } from '../story/schema.ts';
import { checkStory } from '../story/check.ts';

export async function extendWorld(slug: string, selected: string[], wish: string) {
  const files = new WorldFiles(slug);
  const oldWorld = World.parse(files.readJson(files.path('world.json')));
  const oldStory = Story.parse(files.readJson(files.path('story.json')));
  const drawings = selected.map(file => {
    const d = readDrawn(files).find(x => `drawings/${x.file}` === file);
    if (!d || !fs.existsSync(files.path(file))) throw new Error(`${file} is not a saved, read drawing`);
    return d;
  });
  // The story uses effective props (including manual edits), while only the base world is persisted.
  const effective = withThingEdits(oldWorld, files.dir);
  const designed = await designExtension(files.memo, effective, oldStory, drawings, wish);
  // Preserve the corrections layer: use each unchanged original place and add only new things to the anchor.
  const oldByKey = new Map(oldWorld.places.map(p => [p.key, p]));
  const effectiveByKey = new Map(effective.places.map(p => [p.key, p]));
  const world = { ...designed.world, places: designed.world.places.map(p => {
    const old = oldByKey.get(p.key);
    if (!old) return p;
    if (!designed.changed.includes(p.key)) return old;
    const before = effectiveByKey.get(p.key)!;
    return { ...old, things: [...old.things, ...p.things.filter(t => !before.things.some(x => x.key === t.key))], exits: p.exits };
  }) };
  const checked = checkStory(withThingEdits(World.parse(world), files.dir), designed.story);
  if (checked.issues.length) throw new Error(`story does not fit the corrected world: ${checked.issues.join('; ')}`);
  const oldNpc = new Set(oldWorld.places.flatMap(p => p.things.filter(t => t.role === 'npc').map(t => t.key)));
  const newNpc = [...new Set(world.places.flatMap(p => p.things.filter(t => t.role === 'npc' && !oldNpc.has(t.key)).map(t => t.key)))];
  const newItems = designed.story.items.filter(i => !oldStory.items.some(o => o.key === i.key)).map(i => i.key);
  files.write(files.path('world.json'), world);
  files.write(files.path('story.json'), designed.story);
  files.write(files.path('routes.json'), checked.routes);
  console.log(`extension planned: ${designed.changed.join(', ')}; ${checked.states} story states checked`);
  const newPlaces = designed.changed.filter(key => !oldWorld.places.some(place => place.key === key));
  emit('extension.progress', { phase: 'places', total: designed.changed.length, newPlaces, ...(newNpc.length && { task: 'characters' }) });
  // Builds run in the private copy; the original remains playable until the whole job succeeds.
  if (newNpc.length) {
    await registry.get('cast')!.run([slug, ...newNpc]);
    const missing = newNpc.filter(key => !fs.existsSync(files.path('cast', `${key}.png`)));
    if (missing.length) throw new Error(`characters could not be painted: ${missing.join(', ')}`);
  }
  for (const [index, place] of designed.changed.entries()) {
    emit('extension.progress', { phase: 'places', place, index: index + 1, total: designed.changed.length });
    console.log(`building ${place}`);
    process.exitCode = 0;
    await registry.get('build')!.run([slug, '--from', 'layout', '--to', 'verify', '--place', place]);
    if (process.exitCode) throw new Error(`${place} is not playable; extension was not installed`);
  }
  emit('extension.progress', { phase: 'audio' });
  if (newItems.length) await registry.get('icons')!.run([slug, ...newItems]);
  await registry.get('voices')!.run([slug]);
  await registry.get('sound')!.run([slug]);
  console.log(`extension complete: ${designed.changed.join(', ')}; new characters: ${newNpc.join(', ') || 'none'}`);
}

defineCommand({
  name: 'extend',
  usage: 'extend <slug> <JSON drawing paths> <wish>  extend a built world from saved drawings',
  async run([slug, json, wish]) {
    if (!slug || !json || !wish) throw new Error('usage: diorama extend <slug> <JSON drawing paths> <wish>');
    const selected: unknown = JSON.parse(json);
    if (!Array.isArray(selected) || !selected.length || !selected.every(f => typeof f === 'string' && /^drawings\/[a-z0-9-]+\.png$/.test(f))) throw new Error('drawings must be an array of drawings/*.png paths');
    emit('extension.progress', { phase: 'plan' });
    await stagedExtension(slug, () => extendWorld(slug, selected, wish));
  },
});
