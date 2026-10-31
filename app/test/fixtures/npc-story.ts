import { World } from '../../src/world/schema.ts';
import { Story } from '../../src/story/schema.ts';

export const npcWorld = World.parse({
  title: 'The gardener', pitch: 'Meet the gardener again outside.', style: 'painted storybook adventure', start: 'room',
  hero: { key: 'hero', looks: 'a child in a blue coat' },
  places: [
    { key: 'room', shows: 'a room with two posts and a door', mood: 'calm', exits: [{ via: 'door', to: 'garden' }], things: [
      { key: 'guard', role: 'npc', looks: 'a gardener in a green coat' },
      { key: 'left-post', role: 'prop', looks: 'a blue post' }, { key: 'right-post', role: 'prop', looks: 'a red post' },
      { key: 'door', role: 'exit', looks: 'a door to the garden' },
    ] },
    { key: 'garden', shows: 'a garden outside the room', mood: 'sunny', exits: [{ via: 'gate', to: 'room' }], things: [
      { key: 'gate', role: 'exit', looks: 'a gate back inside' }, { key: 'flowers', role: 'prop', looks: 'bright flowers' },
    ] },
  ],
});
export const npcStory = Story.parse({
  intro: 'The gardener is busy.', items: [],
  patrols: [{ npc: 'guard', place: 'room', via: ['left-post', 'right-post'], pause: 0.5 }],
  interactions: [{ place: 'garden', thing: 'guard', verb: 'look', say: 'Here is the gardener.' }],
  dialogues: [
    { npc: 'guard', place: 'room', start: 'hello', lines: [{ key: 'hello', says: 'I will go outside.', choices: [
      { text: 'See you in the garden.', do: [{ moveNpc: { npc: 'guard', to: 'garden' } }] },
    ] }] },
    { npc: 'guard', place: 'garden', start: 'hello', lines: [{ key: 'hello', says: 'Here are my flowers.', choices: [
      { text: 'Let us go back.', do: [{ moveNpc: { npc: 'guard', to: 'room' } }] },
      { text: 'They are lovely.', do: [{ ending: 'done' }] },
    ] }] },
  ],
  endings: [{ key: 'done', title: 'Flowers', text: 'We admired the flowers.' }],
});
