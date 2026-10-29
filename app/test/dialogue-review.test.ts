import { expect, test, vi } from 'vitest';
import { designStory } from '../src/story/design.ts';
import { askSparkJson } from '../src/meta/spark.ts';
import { checkStory } from '../src/story/check.ts';
import { Story } from '../src/story/schema.ts';
import type { World } from '../src/world/schema.ts';
import { Memo } from '../src/meta/memo.ts';

vi.mock('../src/meta/spark.ts', () => ({ askSparkJson: vi.fn() }));
vi.mock('../src/story/check.ts', async (original) => ({ ...await original<object>(), checkStory: vi.fn(), paintingIssues: () => [] }));

test('a mechanically playable but narratorial script is revised before acceptance', async () => {
  const story = Story.parse({ intro: 'Witaj.', items: [], interactions: [{ place: 'garden', thing: 'can', verb: 'take', say: 'Bierzesz konewkę.' }], endings: [{ key: 'end', title: 'Koniec', text: 'Udało się.' }] });
  const revised = { ...story, interactions: [{ ...story.interactions[0], say: 'Ojej, ciężka ta konewka!' }] };
  vi.mocked(checkStory).mockImplementation((_, answer) => ({ story: answer as Story, issues: [], routes: [{ ending: 'end', steps: Array(6).fill('take'), actions: [] }], states: 7 }));
  vi.mocked(askSparkJson).mockResolvedValueOnce(story).mockResolvedValueOnce({ issues: ['interactions.0.say: use the hero’s own voice, not second-person narration'] })
    .mockResolvedValueOnce(revised).mockResolvedValueOnce({ issues: [] });
  const world = { language: 'Polish', audience: 'kids' } as World;
  const result = await designStory(new Memo('/unused-test-memo'), world);
  expect(result.story.interactions[0].say).toBe('Ojej, ciężka ta konewka!');
  expect(askSparkJson).toHaveBeenCalledTimes(4);
  expect(vi.mocked(askSparkJson).mock.calls[2][1].prompt).toContain('second-person narration');
});
