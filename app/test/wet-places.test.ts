import { expect, test } from 'vitest';
import { mayBeWet } from '../src/scene/layers.ts';

const place = (shows: string, things: string[] = ['stol']) => ({ key: 'p', shows, mood: 'quiet', things: things.map((key) => ({ key, kind: 'prop', looks: key })), exits: [] }) as never;

test('water is looked for only where the place could have some', () => {
  expect(mayBeWet(place('A clockmaker workshop full of ticking clocks'))).toBe(false);
  expect(mayBeWet(place('Zakurzony warsztat zegarmistrza'))).toBe(false);
  expect(mayBeWet(place('A misty harbour at night with moored boats'))).toBe(true);
  expect(mayBeWet(place('Mostek nad strumieniem w parku'))).toBe(true);
  expect(mayBeWet(place('A square', ['fontanna']))).toBe(true);
});
