import { expect, test } from 'vitest';
import { checkWorld } from '../src/world/schema.ts';

const place = (key: string, exitsTo: string[]) => ({
  key,
  shows: `the ${key} from a little above`,
  mood: 'evening',
  things: [{ key: 'lamp', role: 'prop', looks: 'an iron lamp' }, ...exitsTo.map((to) => ({ key: `to-${to}`, role: 'exit', looks: 'a door' }))],
  exits: exitsTo.map((to) => ({ to, via: `to-${to}` })),
});
const world = (places: unknown[]) => ({
  title: 'Test', pitch: 'A tiny world for tests.', style: 'gouache on rough paper', start: 'a',
  hero: { key: 'hero', looks: 'a girl in a green coat' }, places,
});

test('two places joined both ways pass', () => {
  expect(checkWorld(world([place('a', ['b']), place('b', ['a'])])).issues).toEqual([]);
});

test('one-way, dangling and unreachable exits are named', () => {
  const { world: w, issues } = checkWorld(world([place('a', ['b']), place('b', []), place('c', ['nowhere'])]));
  expect(w).toBeUndefined();
  expect(issues).toEqual(expect.arrayContaining([
    'b has no exit back to a',
    'c: exit leads to unknown place "nowhere"',
    'c cannot be reached from a',
  ]));
});

test('schema problems carry their path', () => {
  expect(checkWorld({ title: 'x' }).issues.some((i) => i.startsWith('pitch'))).toBe(true);
});
