import { expect, test } from 'vitest';
import { questionIssues } from '../src/story/check.ts';
import { Story } from '../src/story/schema.ts';

test('a question in a say, or in a line without answers, is flagged; one with answers is fine', () => {
  const story = Story.parse({
    intro: 'Hi.',
    items: [],
    interactions: [
      { place: 'quay', thing: 'vendor', verb: 'look', say: 'Morning! Fancy a warm pretzel?' },
      { place: 'quay', thing: 'bench', verb: 'look', say: 'A green bench.' },
    ],
    dialogues: [{ npc: 'vendor', place: 'quay', start: 'hi', lines: [
      { key: 'hi', says: 'Fancy a pretzel?', choices: [{ text: 'Yes', next: 'bye' }] },
      { key: 'bye', says: 'Want another one?' },
    ] }],
    endings: [{ key: 'end', title: 'End', text: 'The end.' }],
  });
  const issues = questionIssues(story);
  expect(issues).toHaveLength(2);
  expect(issues[0]).toContain('interaction 1');
  expect(issues[1]).toContain('line bye');
});
