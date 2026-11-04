import { describe, expect, it } from 'vitest';
import { hintFor, useFor, type State } from '../src/story/engine.ts';
import type { Story } from '../src/story/schema.ts';

const story = {
  intro: 'x', items: [{ key: 'oar', name: 'Oar' }, { key: 'lantern', name: 'Lantern' }],
  locks: [{ place: 'quay', via: 'boat', until: ['boat-oar', 'lantern-lit'], say: 'Not ready.' }],
  interactions: [
    { place: 'quay', thing: 'oar', verb: 'take', when: [], say: 'Got it.', do: [{ give: 'oar' }, { set: 'boat-oar' }], once: true },
    { place: 'quay', thing: 'lamp', verb: 'use', with: 'lantern', when: ['!lantern-lit'], say: 'Lit!', do: [{ set: 'lantern-lit' }], once: false },
    { place: 'mill', thing: 'house', verb: 'take', when: [], say: 'Borrowed.', do: [{ give: 'lantern' }], once: true },
  ],
  dialogues: [], changes: [], patrols: [], endings: [],
} as unknown as Story;
const at = (s: Partial<State>): State => ({ place: 'quay', flags: [], items: [], spent: [], ...s }) as State;

describe('hintFor', () => {
  it('points at the first missing step that can be done now', () => {
    expect(hintFor(story, at({}), ['boat-oar', 'lantern-lit'])).toEqual({ place: 'quay', thing: 'oar' });
  });
  it('points at the lamp once the lantern is in the bag', () => {
    expect(hintFor(story, at({ flags: ['boat-oar'], items: ['oar', 'lantern'], spent: [0] }), ['boat-oar', 'lantern-lit'])).toEqual({ place: 'quay', thing: 'lamp', with: 'lantern' });
  });
  it('gives no hint while the item is still to be found', () => {
    expect(hintFor(story, at({ flags: ['boat-oar'], spent: [0] }), ['boat-oar', 'lantern-lit'])).toBeUndefined();
  });
});

describe('useFor', () => {
  it('finds where an item in hand is wanted here', () => {
    expect(useFor(story, at({ items: ['lantern'] }), 'lantern')).toBe('lamp');
    expect(useFor(story, at({ items: ['lantern'], flags: ['lantern-lit'] }), 'lantern')).toBeUndefined();
  });
});
