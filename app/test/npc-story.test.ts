import { expect, test } from 'vitest';
import { actions, apply, npcHere, pickDialogue, speakerOf, startState, type State } from '../src/story/engine.ts';
import { checkStory, storyNameIssues, storyNeeds } from '../src/story/check.ts';
import { fromWire, Story, WireStory } from '../src/story/schema.ts';
import { npcWorld as world, npcStory as story } from './fixtures/npc-story.ts';

test('story checker reaches an ending through an NPC relocation and return, without ghost conversations', () => {
  const report = checkStory(world, story);
  expect(report.issues).toEqual([]);
  expect(report.routes[0].steps).toEqual(['talk guard', 'choose 1', 'go door', 'talk guard', 'choose 2']);
  const before = startState(world);
  expect(pickDialogue(story, { ...before, place: 'garden' }, 'guard', world)).toBe(-1);
  const speaking = apply(world, story, before, { kind: 'talk', npc: 'guard' }).state;
  const moved = apply(world, story, speaking, { kind: 'choose', index: 0 }).state;
  expect(before.npcs).toBeUndefined();
  expect(moved.npcs).toEqual({ guard: 'garden' });
  expect(actions(world, story, moved)).not.toContainEqual({ kind: 'talk', npc: 'guard' });
  expect(apply(world, story, moved, { kind: 'talk', npc: 'guard' }).say).toEqual([]);
  const outside = apply(world, story, moved, { kind: 'go', via: 'door' }).state;
  expect(npcHere(world, outside, 'guard')).toBe(true);
  expect(actions(world, story, outside)).toContainEqual({ kind: 'do', thing: 'guard', verb: 'look' });
  const talk = apply(world, story, outside, { kind: 'talk', npc: 'guard' }).state;
  const returned = apply(world, story, talk, { kind: 'choose', index: 0 }).state;
  expect(returned.npcs).toEqual({ guard: 'room' });
  expect(moved.npcs).toEqual({ guard: 'garden' });
  expect(actions(world, story, returned)).not.toContainEqual({ kind: 'do', thing: 'guard', verb: 'look' });
  const restored = JSON.parse(JSON.stringify(returned)) as State;
  expect(npcHere(world, { ...restored, place: 'room' }, 'guard')).toBe(true);
  expect(speakerOf(world, { place: 'garden', thing: 'guard', verb: 'talk' })).toBe('guard');
});

test('movement effects also work on object interactions, and repeated moves are harmless', () => {
  const s = Story.parse({ ...story, interactions: [{ place: 'room', thing: 'left-post', verb: 'use', say: 'Go outside.', do: [{ moveNpc: { npc: 'guard', to: 'garden' } }] }] });
  const action = { kind: 'do' as const, thing: 'left-post', verb: 'use' };
  const first = apply(world, s, startState(world), action);
  expect(first.state.npcs).toEqual({ guard: 'garden' });
  expect(apply(world, s, first.state, action)).toEqual(first);
});

test('checker rejects a teleport even if the ending can otherwise be reached', () => {
  const disconnected = { ...world, places: world.places.map(p => ({ ...p, exits: [] })) };
  expect(checkStory(disconnected, story).issues).toContain('NPC "guard" cannot move from "room" to "garden" without a connecting exit');
});

test('patrol and move authoring validates NPCs, destinations, stops and conditions', () => {
  const invalid = Story.parse({ ...story, patrols: [{ npc: 'guard', place: 'room', via: ['guard', 'missing'], when: ['never-set'] }],
    interactions: [{ place: 'room', thing: 'left-post', verb: 'use', say: 'Go.', do: [{ moveNpc: { npc: 'ghost', to: 'missing' } }] }] });
  expect(storyNameIssues(world, invalid)).toEqual(expect.arrayContaining([
    'moveNpc: "ghost" must be an NPC declared in exactly one place', 'moveNpc: unknown place "missing"',
    'patrol of guard in room: stop "guard" must be a fixed object, not a person',
    'patrol of guard in room: "missing" is not a thing in room', 'patrol of guard in room: flag "never-set" is never set',
  ]));
  expect(storyNeeds(story, 'room', 'left-post')).toBe(true);
  expect(Story.safeParse({ ...story, patrols: [{ npc: 'guard', place: 'room', via: ['door'], pause: -1 }] }).success).toBe(false);
});

test('wire effects preserve movement destinations and legacy effects', () => {
  const wire = WireStory.parse({ ...story, interactions: [{ place: 'room', thing: 'left-post', verb: 'use', say: 'Go.', do: [
    { op: 'set', key: 'ready' }, { op: 'moveNpc', key: 'guard', to: 'garden' },
  ] }], dialogues: [] });
  expect(Story.parse(fromWire(wire)).interactions[0].do).toEqual([{ set: 'ready' }, { moveNpc: { npc: 'guard', to: 'garden' } }]);
  expect(Story.safeParse(fromWire({ ...wire, interactions: [{ ...wire.interactions[0], do: [{ op: 'moveNpc', key: 'guard' }] }] })).success).toBe(false);
});


test('simple NPC stages change dialogue before optional one-time travel, without a patrol', () => {
  const stagedWorld = { ...world, places: world.places.map(p => p.key === 'room'
    ? { ...p, things: [...p.things, { key: 'garden-key', role: 'item' as const, looks: 'a brass garden key' }] } : p) };
  const staged = Story.parse({ intro: 'The gardener needs a key.', items: [{ key: 'garden-key', name: 'Garden key' }],
    interactions: [{ place: 'room', thing: 'garden-key', verb: 'take', say: 'Here is the key.', once: true, do: [{ give: 'garden-key' }] }],
    dialogues: [
      { npc: 'guard', place: 'room', when: ['!guard-key-received'], start: 'waiting', lines: [
        { key: 'waiting', says: 'Please bring my key.', choices: [{ text: 'Here it is.', when: ['has:garden-key'],
          do: [{ take: 'garden-key' }, { set: 'guard-key-received' }] }] },
      ] },
      { npc: 'guard', place: 'room', when: ['guard-key-received', '!guard-outside'], start: 'ready', lines: [
        { key: 'ready', says: 'Thank you for the key.', choices: [{ text: 'See you outside.',
          do: [{ set: 'guard-outside' }, { moveNpc: { npc: 'guard', to: 'garden' } }] }] },
      ] },
      { npc: 'guard', place: 'garden', when: ['guard-outside'], start: 'outside', lines: [
        { key: 'outside', says: 'The garden is open.', choices: [{ text: 'Lovely.', do: [{ ending: 'done' }] }] },
      ] },
    ], endings: story.endings,
  });
  expect(staged.patrols).toBeUndefined();
  expect(checkStory(stagedWorld, staged).issues).toEqual([]);
  let state = startState(stagedWorld);
  expect(pickDialogue(staged, state, 'guard', stagedWorld)).toBe(0);
  state = apply(stagedWorld, staged, state, { kind: 'do', thing: 'garden-key', verb: 'take' }).state;
  state = apply(stagedWorld, staged, state, { kind: 'talk', npc: 'guard' }).state;
  state = apply(stagedWorld, staged, state, { kind: 'choose', index: 0 }).state;
  expect(state.items).toEqual([]);
  expect(state.flags).toEqual(['guard-key-received']);
  expect(state.npcs).toBeUndefined();
  expect(pickDialogue(staged, state, 'guard', stagedWorld)).toBe(1);
  state = apply(stagedWorld, staged, state, { kind: 'talk', npc: 'guard' }).state;
  state = apply(stagedWorld, staged, state, { kind: 'choose', index: 0 }).state;
  const restored: State = JSON.parse(JSON.stringify(state));
  expect(restored.npcs).toEqual({ guard: 'garden' });
  expect(pickDialogue(staged, restored, 'guard', stagedWorld)).toBe(-1);
  expect(pickDialogue(staged, { ...restored, place: 'garden' }, 'guard', stagedWorld)).toBe(2);
});
