import { expect, test } from 'vitest';
import { checkStory } from '../src/story/check.ts';
import { actions, apply, startState } from '../src/story/engine.ts';
import { Story } from '../src/story/schema.ts';
import { World } from '../src/world/schema.ts';

const world = World.parse({
  title: 'Test', pitch: 'A tiny world for tests.', style: 'gouache on rough paper', start: 'hut',
  hero: { key: 'hero', looks: 'a girl in a green coat' },
  places: [
    { key: 'hut', shows: 'a hut from a little above', mood: 'night', exits: [{ to: 'shore', via: 'door' }],
      things: [{ key: 'door', role: 'exit', looks: 'a door' }, { key: 'lamp', role: 'item', looks: 'an oil lamp' }] },
    { key: 'shore', shows: 'a shore from a little above', mood: 'night', exits: [{ to: 'hut', via: 'path' }],
      things: [{ key: 'path', role: 'exit', looks: 'a path' }, { key: 'ferryman', role: 'npc', looks: 'an old man' }, { key: 'boat', role: 'prop', looks: 'a boat' }] },
  ],
});

const story = {
  intro: 'The ferry waits in the dark.',
  items: [{ key: 'lamp', name: 'oil lamp' }],
  locks: [{ place: 'hut', via: 'door', until: ['lit'], say: 'Too dark to go out without a light.' }],
  interactions: [
    { place: 'hut', thing: 'lamp', verb: 'take', say: 'You take the lamp.', do: [{ give: 'lamp' }, { set: 'lit' }], once: true },
    { place: 'shore', thing: 'boat', verb: 'use', when: ['paid'], say: 'You row away.', do: [{ ending: 'away' }] },
    { place: 'shore', thing: 'boat', verb: 'use', say: 'The ferryman shakes his head.' },
  ],
  dialogues: [{
    npc: 'ferryman', place: 'shore', start: 'hello', lines: [
      { key: 'hello', says: 'Crossing costs a light.', choices: [
        { text: 'Here, take my lamp.', when: ['has:lamp'], do: [{ take: 'lamp' }, { set: 'paid' }] },
        { text: 'I will stay.', do: [{ ending: 'stay' }] },
      ] },
    ],
  }],
  endings: [{ key: 'away', title: 'Across', text: 'You cross.' }, { key: 'stay', title: 'Home', text: 'You stay.' }],
};

test('a small story passes and gives a route to each ending', () => {
  const report = checkStory(world, story);
  expect(report.issues).toEqual([]);
  expect(report.routes.find((r) => r.ending === 'away')?.steps).toEqual(['take lamp', 'go door', 'talk ferryman', 'choose 1', 'use boat']);
});

test('a lock that needs an item you can give away strands the player', () => {
  const report = checkStory(world, { ...story, locks: [{ ...story.locks[0], until: ['has:lamp'] }] });
  expect(report.issues).toEqual(['1 reachable state(s) can never reach an ending, e.g. after: take lamp → go door → talk ferryman → choose 1 → go path']);
});

test('a key that lies behind its own lock means no ending can be reached', () => {
  const report = checkStory(world, {
    ...story,
    locks: [{ ...story.locks[0], until: ['has:lamp'] }],
    interactions: [{ place: 'shore', thing: 'boat', verb: 'look', say: 'A lamp in the boat.', do: [{ give: 'lamp' }] }, ...story.interactions.slice(1)],
  });
  expect(report.issues).toEqual(expect.arrayContaining(['ending "away" cannot be reached', 'ending "stay" cannot be reached']));
  expect(report.issues.some((i) => i.includes('can never reach an ending, e.g. after: the start'))).toBe(true);
});

test('giving the lamp away before using it elsewhere strands the player', () => {
  const needsLampLater = { ...story, interactions: [...story.interactions] };
  needsLampLater.interactions.splice(1, 0, { place: 'shore', thing: 'boat', verb: 'use', when: ['paid', '!has:lamp'], say: 'Too dark to row.' } as never);
  const report = checkStory(world, needsLampLater);
  expect(report.issues.some((i) => i.startsWith('ending "away"'))).toBe(true);
});

test('unknown names are reported before the search', () => {
  const report = checkStory(world, { ...story, interactions: [{ place: 'hut', thing: 'ghost', verb: 'look', say: 'x', when: ['brave'] }] });
  expect(report.issues).toEqual(expect.arrayContaining([
    'interaction 1 (look ghost): "ghost" is not a thing in hut',
    'interaction 1 (look ghost): flag "brave" is never set',
  ]));
});

test('a locked exit refuses with its line and does not move', () => {
  const s = Story.parse(story);
  const start = startState(world);
  expect(actions(world, s, start).map((a) => a.kind)).toEqual(['do']);
  expect(apply(world, s, start, { kind: 'go', via: 'door' })).toEqual({ state: start, say: ['Too dark to go out without a light.'] });
});
