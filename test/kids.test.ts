import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { drawingsBrief, drawnIssues, readKinds, type Drawn } from '../src/world/drawings.ts';
import { WorldFiles } from '../src/world/files.ts';
import { World } from '../src/world/schema.ts';
import { pieces } from '../src/world/told.ts';

const world = World.parse({
  title: 'Czapka smoka', pitch: 'Smok zgubił czapkę i jest mu zimno.', style: 'wax crayon on paper', start: 'forest',
  hero: { key: 'girl-with-cat', looks: 'a girl with long yellow hair and a grey kitten' },
  places: [
    { key: 'forest', shows: 'a forest with a giant red mushroom', mood: 'sunny', exits: [{ to: 'meadow', via: 'hut' }],
      things: [{ key: 'hut', role: 'exit', looks: 'a little wooden hut' }, { key: 'green-dragon', role: 'npc', looks: 'a green dragon' }] },
    { key: 'meadow', shows: 'a meadow with flowers', mood: 'sunny', exits: [{ to: 'forest', via: 'path' }],
      things: [{ key: 'path', role: 'exit', looks: 'a path' }, { key: 'blue-hat', role: 'prop', looks: 'a blue hat' }] },
  ],
  language: 'Polish',
  audience: 'kids',
});

const drawn: Drawn[] = [
  { file: '01-zosia.png', kind: 'hero', key: 'girl-with-cat', looks: 'a girl' },
  { file: '02-smok.png', kind: 'npc', key: 'green-dragon', looks: 'a dragon' },
  { file: '03-czapka.png', kind: 'item', key: 'blue-hat', looks: 'a hat' },
  { file: '04-las.png', kind: 'place', key: 'forest', looks: 'a forest' },
  { file: '05-chatka.png', kind: 'prop', key: 'hut', looks: 'a hut' },
  { file: '06-grzyb.png', kind: 'prop', key: 'mushroom', looks: 'a mushroom' },
];

test('every drawing has to be in the world under its key and role; a drawn prop may be an exit', () => {
  expect(drawnIssues(world, drawn)).toEqual([
    '"blue-hat" was drawn as an item: its role must be "item"',
    'a child drew "mushroom": it must be a thing with role "prop" in one of the places',
  ]);
  expect(drawnIssues({ ...world, hero: { key: 'someone', looks: 'someone else entirely' } }, drawn.slice(0, 1))).toEqual(['the hero\'s key must be "girl-with-cat" (a child drew the hero)']);
});

test('the designer brief names each drawing once, with its key', () => {
  const brief = drawingsBrief([...drawn, { ...drawn[1], file: '07-smok-2.png' }]);
  expect(brief.match(/green-dragon/g)).toHaveLength(1);
  expect(brief).toContain('the hero, key "girl-with-cat"');
});

test('a long recording is cut into pieces near 40 s, at its quietest moment', () => {
  const rate = 24000;
  const pcm = Buffer.alloc(rate * 2 * 100);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 7)), i * 2);
  // Silence at 42-43 s: the first cut lands there.
  pcm.fill(0, 42 * rate * 2, 43 * rate * 2);
  const cut = pieces(pcm);
  expect(cut.length).toBe(3);
  expect(cut[0].length / 2 / rate).toBeGreaterThan(42);
  expect(cut[0].length / 2 / rate).toBeLessThan(43.1);
  expect(cut.reduce((n, p) => n + p.length, 0)).toBe(pcm.length);
  expect(pieces(pcm.subarray(0, rate * 2 * 30))).toHaveLength(1);
});

test('what the grown-up says a drawing is, read from drawings/kinds.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kids-'));
  const files = new WorldFiles('workshop', root);
  expect(readKinds(files)).toEqual({});
  files.write(files.path('drawings', 'kinds.json'), { '02-smok.png': 'hero', '03-x.png': 'nonsense' });
  expect(readKinds(files)).toEqual({});
  files.write(files.path('drawings', 'kinds.json'), { '02-smok.png': 'hero' });
  expect(readKinds(files)).toEqual({ '02-smok.png': 'hero' });
});
