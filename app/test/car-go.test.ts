import { expect, test } from 'vitest';
import { actions, apply, startState } from '../src/story/engine.ts';
import type { Story } from '../src/story/schema.ts';
import type { World } from '../src/world/schema.ts';

const place = (key: string, kind?: 'drive') => ({ key, ...(kind && { kind }), shows: `the ${key} place`, mood: 'sunny', things: [{ key: 'car', role: 'exit' as const, looks: 'a black car' }], exits: [] as Array<{ to: string; via: string }> });
const world = { title: 't', pitch: 'a pitch of ten', style: 'a style of ten', start: 'a', hero: { key: 'h', looks: 'a hero head to toe' }, places: [place('a'), place('b'), place('ride', 'drive')] } as World;
world.places[0].exits = [{ to: 'ride', via: 'car' }];
world.places[1].exits = [{ to: 'ride', via: 'car' }];
world.places[2].exits = [{ to: 'a', via: 'car' }, { to: 'b', via: 'car' }];
const story = { intro: 'x', items: [], locks: [], interactions: [], dialogues: [], changes: [], patrols: [], endings: [] } as unknown as Story;

test('a car that leads to several places offers a go per destination, and goes where `to` says', () => {
  let state = apply(world, story, startState(world), { kind: 'go', via: 'car' }).state;
  expect(state.place).toBe('ride');
  expect(actions(world, story, state).filter((a) => a.kind === 'go')).toEqual([{ kind: 'go', via: 'car', to: 'a' }, { kind: 'go', via: 'car', to: 'b' }]);
  state = apply(world, story, state, { kind: 'go', via: 'car', to: 'b' }).state;
  expect(state.place).toBe('b');
});
