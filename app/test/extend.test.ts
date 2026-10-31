import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import '../src/actions/index.ts';
import { runAction } from '../src/actions/registry.ts';
import { Story } from '../src/story/schema.ts';
import { Events } from '../src/studio/events.ts';
import { Jobs } from '../src/studio/jobs.ts';
import { mergeStory, mergeWorld } from '../src/world/extend.ts';
import { World } from '../src/world/schema.ts';

const base = World.parse({ title: 'Quay', pitch: 'A small quay by the river.', style: 'soft painted colours', start: 'dock', hero: { key: 'hero', looks: 'a curious young sailor' }, places: [{ key: 'dock', shows: 'a small quiet river dock', mood: 'sunny', things: [{ key: 'lamp', role: 'item', looks: 'a blue lamp' }, { key: 'boat', role: 'prop', looks: 'a small boat' }], exits: [] }] });
const story = Story.parse({ intro: 'Find a light.', items: [{ key: 'lamp', name: 'Lamp' }], interactions: [
  { place: 'dock', thing: 'lamp', verb: 'take', say: 'A lamp!', do: [{ give: 'lamp' }], once: true },
  { place: 'dock', thing: 'boat', verb: 'use', with: 'lamp', say: 'The boat is ready.', do: [{ ending: 'home' }] },
], endings: [{ key: 'home', title: 'Home', text: 'The boat sails.' }] });
const drawing = { file: '02-hill.png', kind: 'place' as const, key: 'hill', looks: 'a green hill in the sun' };
const plan = { anchor: 'dock', things: [{ key: 'hill-path', role: 'exit', looks: 'a path uphill' }], exits: [{ via: 'hill-path', to: 'hill' }], places: [{ key: 'hill', shows: 'a green hill in the sun', mood: 'sunny', things: [{ key: 'dock-path', role: 'exit', looks: 'a path to the dock' }, { key: 'fox', role: 'npc', looks: 'a friendly red fox' }], exits: [{ via: 'dock-path', to: 'dock' }] }] };
const additions = { items: [], locks: [], changes: [], endings: [{ key: 'hill-end', title: 'Friends', text: 'The fox waves.' }], interactions: [
  { place: 'dock', thing: 'hill-path', verb: 'look', say: 'A path up.' },
  { place: 'hill', thing: 'dock-path', verb: 'look', say: 'The path home.' },
  { place: 'hill', thing: 'fox', verb: 'look', say: 'A fox!' },
], dialogues: [{ place: 'hill', npc: 'fox', start: 'hi', lines: [{ key: 'hi', says: 'Hello, sailor!', choices: [{ text: 'Hello!', do: [{ ending: 'hill-end' }] }] }] }] };

test('extension preserves old places and script, and the new scene is reachable', () => {
  const result = mergeWorld(base, plan, [drawing]);
  expect(result.issues).toEqual([]);
  expect(result.world!.places[0].things.slice(0, 2)).toEqual(base.places[0].things);
  expect(result.world!.hero).toEqual(base.hero);
  const extended = mergeStory(result.world!, story, additions, result.changed, base);
  expect(extended.issues).toEqual([]);
  expect(extended.story!.interactions.slice(0, story.interactions.length)).toEqual(story.interactions);
  expect(extended.story!.endings.slice(0, story.endings.length)).toEqual(story.endings);
});

test('rejects disconnected places, overwritten identities, incomplete drawings and inaccessible dialogue', () => {
  expect(mergeWorld(base, { ...plan, exits: [] }, [drawing]).issues.join(' ')).toMatch(/connect|reached/);
  expect(mergeWorld(base, { ...plan, things: [{ key: 'lamp', role: 'exit', looks: 'new path' }] }, [drawing]).issues.join(' ')).toMatch(/reuse/);
  expect(mergeWorld(base, { ...plan, places: [] }, [drawing]).issues.join(' ')).toMatch(/hill/);
  const result = mergeWorld(base, plan, [drawing]);
  expect(mergeStory(result.world!, story, { ...additions, dialogues: [] }, result.changed, base).issues.join(' ')).toMatch(/dialogue/);
  expect(mergeStory(result.world!, story, { ...additions, interactions: [...additions.interactions, { place: 'dock', thing: 'boat', verb: 'look', say: 'New line.' }] }, result.changed, base).issues.join(' ')).toMatch(/existing script/);
});

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(r => fs.rmSync(r, { recursive: true, force: true })));
test('Studio exposes a queued, lock-aware extension and refuses already incorporated drawings', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-extend-')); roots.push(root);
  const dir = path.join(root, 'w'); fs.mkdirSync(path.join(dir, 'drawings'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify(base));
  fs.writeFileSync(path.join(dir, 'story.json'), JSON.stringify(story));
  fs.writeFileSync(path.join(dir, 'drawings.json'), JSON.stringify([drawing, { file: '01-lamp.png', kind: 'item', key: 'lamp', looks: 'a blue lamp' }]));
  fs.writeFileSync(path.join(dir, 'drawings', drawing.file), 'image');
  fs.writeFileSync(path.join(dir, 'drawings', '01-lamp.png'), 'image');
  const events = new Events();
  const jobs = new Jobs(events, { bin: fileURLToPath(new URL('./fixtures/fake-diorama.mjs', import.meta.url)) });
  const ctx = { root, by: 'agent' as const, events, jobs };
  await expect(runAction('world_extend', { slug: 'w', files: ['drawings/01-lamp.png'], wish: 'Add the lamp' }, ctx)).rejects.toThrow(/already in the world/);
  await runAction('lock_set', { slug: 'w', place: 'dock', locked: true }, ctx);
  await expect(runAction('world_extend', { slug: 'w', files: ['drawings/02-hill.png'], wish: 'Add the hill' }, ctx)).rejects.toThrow(/locked/);
  await runAction('lock_set', { slug: 'w', place: 'dock', locked: false }, { ...ctx, by: 'user' });
  const job = await runAction('world_extend', { slug: 'w', files: ['drawings/02-hill.png'], wish: 'Add the hill' }, ctx) as { id: string; args: string[] };
  expect(job.args).toEqual(['extend', 'w', '["drawings/02-hill.png"]', 'Add the hill']);
  await jobs.wait(job.id);
});

test('staged extension installs completed work and leaves the original intact on failure or conflict', async () => {
  const { stagedExtension } = await import('../src/world/extend-stage.ts');
  const originalCwd = process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-stage-test-')); roots.push(root);
  const dir = path.join(root, 'worlds', 'w');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'world.json'), 'old');
  fs.mkdirSync(path.join(dir, 'studio')); fs.writeFileSync(path.join(dir, 'studio', 'conversation.md'), 'keep');
  try {
    process.chdir(root);
    await expect(stagedExtension('w', async () => {
      fs.writeFileSync('worlds/w/world.json', 'broken');
      throw new Error('model failed');
    })).rejects.toThrow('model failed');
    expect(fs.readFileSync(path.join(dir, 'world.json'), 'utf8')).toBe('old');
    await expect(stagedExtension('w', async () => {
      fs.writeFileSync('worlds/w/world.json', 'new');
      fs.writeFileSync(path.join(dir, 'world.json'), 'other edit');
    })).rejects.toThrow(/world changed during extension/);
    expect(fs.readFileSync(path.join(dir, 'world.json'), 'utf8')).toBe('other edit');
    await stagedExtension('w', async () => {
      fs.writeFileSync('worlds/w/world.json', 'new');
      fs.mkdirSync('worlds/w/places/hill', { recursive: true });
      fs.writeFileSync('worlds/w/places/hill/painting.png', 'painting');
    });
    expect(fs.readFileSync(path.join(dir, 'world.json'), 'utf8')).toBe('new');
    expect(fs.readFileSync(path.join(dir, 'places/hill/painting.png'), 'utf8')).toBe('painting');
    expect(fs.readFileSync(path.join(dir, 'studio/conversation.md'), 'utf8')).toBe('keep');
  } finally { process.chdir(originalCwd); }
});

test('a picture already saved as a drawing is reused without sending its bytes to the agent', async () => {
  const sharp = (await import('sharp')).default;
  const { normaliseDrawing } = await import('../src/world/drawings.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-picture-')); roots.push(root);
  const dir = path.join(root, 'w');
  fs.mkdirSync(path.join(dir, 'studio/pictures'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'drawings'), { recursive: true });
  const jpg = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).jpeg().toBuffer();
  fs.writeFileSync(path.join(dir, 'studio/pictures/01.jpg'), jpg);
  fs.writeFileSync(path.join(dir, 'drawings', drawing.file), await normaliseDrawing(jpg));
  fs.writeFileSync(path.join(dir, 'drawings.json'), JSON.stringify([drawing]));
  const events = new Events();
  const ctx = { root, by: 'agent' as const, events, jobs: new Jobs(events) };
  const first = await runAction('kids_from_picture', { slug: 'w', picture: 'studio/pictures/01.jpg' }, ctx);
  expect(first).toMatchObject({ file: `drawings/${drawing.file}`, reused: true });
  expect(await runAction('kids_from_picture', { slug: 'w', picture: 'studio/pictures/01.jpg' }, ctx)).toEqual(first);
  expect(fs.readdirSync(path.join(dir, 'drawings')).filter(f => f.endsWith('.png'))).toHaveLength(1);
});

test('designer retries invalid plans and scripts before accepting a playable extension', async () => {
  const { vi } = await import('vitest');
  const spark = await import('../src/meta/spark.ts');
  const { designExtension } = await import('../src/world/extend.ts');
  const { Memo } = await import('../src/meta/memo.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-design-')); roots.push(root);
  const ask = vi.spyOn(spark, 'askSparkJson')
    .mockResolvedValueOnce({ ...plan, exits: [] })
    .mockResolvedValueOnce(plan)
    .mockResolvedValueOnce({ ...additions, dialogues: [] })
    .mockResolvedValueOnce(additions);
  try {
    const result = await designExtension(new Memo(root), base, story, [drawing], 'Add the sunny hill');
    expect(result.changed).toEqual(['dock', 'hill']);
    expect(result.report.issues).toEqual([]);
    expect(ask).toHaveBeenCalledTimes(4);
  } finally { ask.mockRestore(); }
});

test('a new character drawing in a built world stays an NPC instead of replacing its hero', async () => {
  const { vi } = await import('vitest');
  const sharp = (await import('sharp')).default;
  const drawings = await import('../src/world/drawings.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-new-npc-')); roots.push(root);
  const dir = path.join(root, 'w'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify(base));
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toBuffer();
  const read = vi.spyOn(drawings, 'readDrawing').mockResolvedValue({ file: '01-fox.png', kind: 'npc', key: 'fox', looks: 'a red fox' });
  const events = new Events(); const ctx = { root, by: 'agent' as const, events, jobs: new Jobs(events) };
  try {
    await runAction('kids_add', { slug: 'w', kind: 'drawing', name: 'fox.png', data: image.toString('base64') }, ctx);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'drawings.json'), 'utf8'))[0].kind).toBe('npc');
  } finally { read.mockRestore(); }
});


test('extension retains NPC stages and patrol priority and protects flags used only by old motion', () => {
  const oldWorld = World.parse({ ...base, places: [{ ...base.places[0], things: [
    ...base.places[0].things, { key: 'watcher', role: 'npc', looks: 'a quiet dock watcher' },
  ] }] });
  const old = Story.parse({ ...story,
    patrols: [{ npc: 'watcher', place: 'dock', via: ['lamp', 'boat'], when: ['!watcher-resting'], pause: 2 }],
    dialogues: [{ npc: 'watcher', place: 'dock', start: 'hello', lines: [{ key: 'hello', says: 'I saw you arrive.',
      choices: [{ text: 'Hello.', do: [{ set: 'watcher-met' }] }] }] }],
  });
  const expandedPlan = { ...plan, places: [{ ...plan.places[0], things: [
    ...plan.places[0].things, { key: 'oak', role: 'prop', looks: 'a broad green oak' },
  ] }] };
  const grown = mergeWorld(oldWorld, expandedPlan, [drawing]);
  expect(grown.issues).toEqual([]);
  const extra = { ...additions,
    patrols: [{ npc: 'fox', place: 'hill', via: ['dock-path', 'oak'], when: ['!fox-met'], pause: 3 }],
    interactions: [...additions.interactions, { place: 'hill', thing: 'oak', verb: 'look', say: 'A tall oak.' }],
    dialogues: [{ ...additions.dialogues[0], lines: [{ key: 'hi', says: 'Hello, sailor!',
      choices: [{ text: 'Hello!', do: [{ set: 'fox-met' }, { ending: 'hill-end' }] }] }] }],
  };
  const result = mergeStory(grown.world!, old, extra, grown.changed, oldWorld);
  expect(result.issues).toEqual([]);
  expect(result.story!.patrols?.[0]).toEqual(old.patrols![0]);
  expect(result.story!.patrols?.[1].npc).toBe('fox');
  expect(result.story!.dialogues[0]).toEqual(old.dialogues[0]);
  expect(old.patrols).toHaveLength(1);
  const clobber = { ...extra, dialogues: [{ ...extra.dialogues[0], lines: [{ key: 'hi', says: 'Hello.',
    choices: [{ text: 'Hello.', do: [{ set: 'watcher-resting' }, { ending: 'hill-end' }] }] }] }] };
  expect(mergeStory(grown.world!, old, clobber, grown.changed, oldWorld).issues)
    .toContain('new effects must not change old flags or inventory items');
  expect(mergeStory(grown.world!, old, { ...extra, patrols: [...extra.patrols, old.patrols![0]] }, grown.changed, oldWorld).issues)
    .toContain('new motion must not change existing NPCs');
});
