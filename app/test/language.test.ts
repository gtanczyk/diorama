import { expect, test } from 'vitest';
import { Story } from '../src/story/schema.ts';
import { applyWorldTexts, relanguage, worldTexts } from '../src/world/language.ts';
import type { World } from '../src/world/schema.ts';

const world: World = {
  title: 'Magiczny Tost', pitch: 'Mały bohater niesie magiczny tost.', style: 'wax crayon, bold outlines', start: 'kitchen',
  hero: { key: 'hero', looks: 'a small tan-orange person' },
  places: [{ key: 'kitchen', shows: 'A cheerful kitchen with a table', mood: 'sunny', things: [{ key: 'cat', role: 'npc', looks: 'round orange cat' }, { key: 'jar', role: 'item', looks: 'jar of jam' }], exits: [] }],
  names: { hero: 'Tostowy Bohater', cat: 'Kot Maślak' }, language: 'Polish',
};
const story = Story.parse({
  intro: 'Pomóż mu!',
  items: [{ key: 'jar', name: 'słoik dżemu', nope: 'Tu nie pomoże.' }],
  interactions: [{ place: 'kitchen', thing: 'jar', verb: 'take', say: 'Mam dżem!', do: [{ give: 'jar' }], once: true }],
  dialogues: [{ npc: 'cat', place: 'kitchen', start: 'a', lines: [{ key: 'a', says: 'Miau.', choices: [{ text: 'Cześć!' }] }] }],
  changes: [{ place: 'kitchen', thing: 'jar', when: ['fed'], looks: 'an empty jar' }],
  endings: [{ key: 'end', title: 'Koniec', text: 'Udało się!' }],
});

test('every player-facing text has an id; painter words and keys do not', () => {
  const texts = worldTexts(world, story);
  expect(Object.keys(texts).sort()).toEqual([
    'names.cat', 'names.hero', 'story.dialogues.0.lines.0.choices.0.text', 'story.dialogues.0.lines.0.says', 'story.endings.0.text', 'story.endings.0.title',
    'story.interactions.0.say', 'story.intro', 'story.items.0.name', 'story.items.0.nope', 'world.pitch', 'world.title',
  ]);
});

test('translated texts go back where they came from; keys, looks and flags stay', () => {
  const texts = worldTexts(world, story);
  const english = Object.fromEntries(Object.keys(texts).map((id) => [id, `EN ${id}`]));
  const now = applyWorldTexts(world, story, english, 'English');
  expect(now.world.title).toBe('EN world.title');
  expect(now.world.names).toEqual({ hero: 'EN names.hero', cat: 'EN names.cat' });
  expect(now.world.language).toBeUndefined();
  expect(now.world.places).toEqual(world.places);
  expect(now.story!.dialogues[0].lines[0].choices[0].text).toBe('EN story.dialogues.0.lines.0.choices.0.text');
  expect(now.story!.changes[0].looks).toBe('an empty jar');
  expect(now.story!.interactions[0].do).toEqual([{ give: 'jar' }]);
  expect(world.title).toBe('Magiczny Tost');
  expect(applyWorldTexts(world, story, {}, 'German').world.language).toBe('German');
});

test('a voice wish for the old language asks for the new one', () => {
  expect(relanguage('Native Polish speaker. Warm and slow.', 'Polish', 'English')).toBe('Native English speaker. Warm and slow.');
});
