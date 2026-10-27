import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import '../src/actions/index.ts';
import { runAction } from '../src/actions/registry.ts';
import { applyTexts, textAt } from '../src/story/fixes.ts';
import { Story } from '../src/story/schema.ts';
import { Events } from '../src/studio/events.ts';
import { Jobs } from '../src/studio/jobs.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-diorama.mjs', import.meta.url));
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

const STORY = Story.parse({
  intro: 'The last ferry waits for its lamp.',
  items: [{ key: 'lamp', name: 'blue lamp' }],
  interactions: [
    { place: 'dock', thing: 'lamp', verb: 'take', say: 'Still warm.', do: [{ give: 'lamp' }], once: true },
    { place: 'dock', thing: 'ferryman', verb: 'use', with: 'lamp', say: 'He lights the bow.', do: [{ take: 'lamp' }, { ending: 'home' }] },
  ],
  dialogues: [{ npc: 'ferryman', place: 'dock', start: 'ask', lines: [{ key: 'ask', says: 'No lamp, no crossing.', choices: [{ text: 'I will find it.' }] }] }],
  endings: [{ key: 'home', title: 'Across', text: 'The ferry slides into the fog.' }],
});

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-story-'));
  roots.push(root);
  const dir = path.join(root, 'w');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify({
    title: 'Quay', pitch: 'A small quay on a river at dusk.', style: 'gouache, muted river colours', start: 'dock',
    hero: { key: 'wren', looks: 'a keeper in a yellow oilskin' },
    places: [{ key: 'dock', shows: 'a dock at dusk', mood: 'calm', exits: [], things: [{ key: 'ferryman', role: 'npc', looks: 'an old ferryman' }, { key: 'lamp', role: 'item', looks: 'a blue lamp' }] }],
  }));
  fs.writeFileSync(path.join(dir, 'story.json'), JSON.stringify(STORY));
  const events = new Events();
  const jobs = new Jobs(events, { bin: FAKE });
  return { root, dir, ctx: (by: 'user' | 'agent') => ({ by, root, events, jobs }) };
}

test('reworded lines land by their path, and paths that name no text are left out', () => {
  expect(textAt(STORY, 'dialogues.0.lines.0.choices.0.text')).toBe('I will find it.');
  expect(textAt(STORY, 'interactions.0.verb')).toBeNull();
  expect(textAt(STORY, 'interactions.9.say')).toBeNull();
  const at = new Date().toISOString();
  const { story, skipped } = applyTexts(STORY, { texts: { intro: { text: 'Fog.', at }, 'interactions.7.say': { text: 'x', at }, 'items.0.key': { text: 'y', at } } });
  expect(story.intro).toBe('Fog.');
  expect(STORY.intro).not.toBe('Fog.');
  expect(skipped).toEqual(['interactions.7.say', 'items.0.key']);
});

test('story_status gives the checker\'s verdict and a route per ending', async () => {
  const { ctx } = world();
  const s = (await runAction('story_status', { slug: 'w' }, ctx('user'))) as { issues: string[]; routes: { ending: string; steps: string[] }[]; places: unknown[] };
  expect(s.issues).toEqual([]);
  expect(s.routes.map((r) => r.ending)).toEqual(['home']);
  expect(s.routes[0].steps.length).toBeGreaterThan(1);
  expect(s.places).toHaveLength(1);
});

test('story_text rewords story.json and keeps the wording for rebuilds; only text paths are taken', async () => {
  const { dir, ctx } = world();
  const out = (await runAction('story_text', { slug: 'w', path: 'dialogues.0.lines.0.says', text: 'Lamp first, then the river.' }, ctx('user'))) as { before: string; spoken: boolean };
  expect(out).toMatchObject({ before: 'No lamp, no crossing.', spoken: true });
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'story.json'), 'utf8')).dialogues[0].lines[0].says).toBe('Lamp first, then the river.');
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'story-fixes.json'), 'utf8')).texts['dialogues.0.lines.0.says'].text).toBe('Lamp first, then the river.');
  await expect(runAction('story_text', { slug: 'w', path: 'interactions.0.do', text: 'x' }, ctx('user'))).rejects.toThrow(/not a line/);
});

test('story_redo keeps the wish, drops reworded lines and runs the story step; a locked world refuses the agent', async () => {
  const { dir, ctx } = world();
  await runAction('story_text', { slug: 'w', path: 'intro', text: 'Fog over the quay.' }, ctx('user'));
  const job = (await runAction('story_redo', { slug: 'w', wish: 'the ferryman wants a coin too' }, ctx('user'))) as { id: string; args: string[] };
  expect(job.args).toEqual(['story', 'w']);
  await ctx('user').jobs.wait(job.id);
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'story-fixes.json'), 'utf8'))).toEqual({ wish: 'the ferryman wants a coin too', texts: {} });
  await runAction('lock_set', { slug: 'w', locked: true }, ctx('user'));
  await expect(runAction('story_text', { slug: 'w', path: 'intro', text: 'Hi there.' }, ctx('agent'))).rejects.toThrow(/locked/);
});
