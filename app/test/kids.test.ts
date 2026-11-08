import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { drawingsBrief, drawnIssues, grownUpDrawings, KIDS_STYLE, kidsStyle, readKinds, sketchStyle, type Drawn } from '../src/world/drawings.ts';
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
    '"mushroom" was drawn: it must be a thing with role "prop" in one of the places',
  ]);
  expect(drawnIssues({ ...world, hero: { key: 'someone', looks: 'someone else entirely' } }, drawn.slice(0, 1))).toEqual(['the hero\'s key must be "girl-with-cat" (the hero was drawn)']);
});

test('a grown-up\'s sketches make no kids\' world and keep their own medium', () => {
  const sketches: Drawn[] = drawn.map((d) => ({ ...d, by: 'grown-up', medium: 'fountain-pen ink hatching with a grey watercolour wash' }));
  expect(grownUpDrawings(sketches)).toBe(true);
  expect(grownUpDrawings([...sketches, { ...drawn[0], file: '09-kid.png' }])).toBe(false);
  expect(grownUpDrawings([])).toBe(false);
  expect(sketchStyle(sketches)).toContain('fountain-pen ink hatching');
  expect(drawingsBrief(sketches)).toContain('The artist sketched these');
  expect(drawingsBrief(drawn)).toContain('The children drew these');
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

test('one hero: the one asked for, else the one leading, else the first character drawn', async () => {
  const { oneHero } = await import('../src/world/drawings.ts');
  const set = () => drawn.map((d) => ({ ...d }));
  const kinds = (ds: Drawn[]) => ds.filter((d) => d.kind === 'hero').map((d) => d.key);
  expect(kinds(oneHero(set()))).toEqual(['girl-with-cat']);
  expect(kinds(oneHero(set(), 'green-dragon'))).toEqual(['green-dragon']);
  expect(oneHero(set(), 'green-dragon').find((d) => d.key === 'girl-with-cat')!.kind).toBe('npc');
  expect(kinds(oneHero(set().map((d) => (d.kind === 'hero' ? { ...d, kind: 'npc' as const } : d))))).toEqual(['girl-with-cat']);
});

test('a class of drawings: new keys stay apart, drawn places over the asked number become props', async () => {
  const { fitPlaces, ownKeys } = await import('../src/world/drawings.ts');
  const d = (file: string, kind: Drawn['kind'], key: string): Drawn => ({ file, kind, key, looks: `${key} as drawn` });
  const keys = ownKeys([d('01.png', 'npc', 'princess'), d('02.png', 'npc', 'princess'), d('03.png', 'npc', 'princess')]).map((x) => x.key);
  expect(keys).toEqual(['princess', 'princess-2', 'princess-3']);
  // A drawing read earlier as the same thing again (kids_add) keeps the shared key.
  expect(ownKeys([d('01.png', 'npc', 'cat'), d('02.png', 'npc', 'cat'), d('03.png', 'npc', 'cat')], new Set(['01.png', '02.png'])).map((x) => x.key)).toEqual(['cat', 'cat', 'cat-2']);
  const fitted = fitPlaces([d('01.png', 'place', 'castle'), d('02.png', 'hero', 'girl'), d('03.png', 'place', 'forest'), d('04.png', 'place', 'beach')], 2);
  expect(fitted.map((x) => x.kind)).toEqual(['place', 'hero', 'place', 'prop']);
  expect(fitted[3].key).toBe('beach');
});

test('doctor --now says when Meta or the network is too slow for a live build', async () => {
  const { liveVerdict } = await import('../src/commands/doctor.ts');
  expect(liveVerdict({ spark: 5000, 'muse paint': 20000, 'muse edit': 25000, sam: 3000 })).toMatch(/^fast enough/);
  expect(liveVerdict({ spark: 5000, 'muse paint': 90000, 'muse edit': 25000, sam: 65000 })).toBe('SLOW: muse paint, sam. A live build may take 30+ min: play a world built beforehand, or build with fewer drawings and places');
  expect(liveVerdict({ spark: 5000 })).toMatch(/^SLOW: muse paint, muse edit, sam/);
});

test("a child's drawing keeps its own medium as the world's style; crayon or none keeps the kids' style", () => {
  const dino: Drawn = { file: 'a.png', kind: 'hero', key: 'anoti', looks: 'a brown dinosaur', by: 'child', medium: 'oil pastel, thick waxy strokes on white paper' };
  expect(kidsStyle([dino])).toContain('oil pastel, thick waxy strokes on white paper');
  expect(kidsStyle([dino])).not.toContain('felt-tip');
  expect(kidsStyle([{ ...dino, medium: undefined }])).toBe(KIDS_STYLE);
  expect(kidsStyle([{ ...dino, medium: 'wax crayon' }])).toBe(KIDS_STYLE);
  expect(kidsStyle([{ ...dino, by: 'grown-up' }])).toBe(KIDS_STYLE);
});
