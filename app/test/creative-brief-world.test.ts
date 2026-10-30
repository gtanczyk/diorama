import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
const state = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/world/files.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/world/files.ts')>();
  return { ...actual, WorldFiles: class extends actual.WorldFiles { constructor(slug: string) { super(slug, state.root); } } };
});
vi.mock('../src/world/design.ts', () => ({ designWorld: vi.fn() }));
import '../src/commands/world.ts';
import { registry } from '../src/registry.ts';
import { WorldFiles } from '../src/world/files.ts';
import { designWorld } from '../src/world/design.ts';
import { KIDS_STYLE } from '../src/world/drawings.ts';
import type { CreativeChoices } from '../src/world/idea-review.ts';
import type { World } from '../src/world/schema.ts';

beforeEach(() => { state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-creative-world-')); vi.mocked(designWorld).mockReset(); });
afterEach(() => fs.rmSync(state.root, { recursive: true, force: true }));

test.each([false, true])('world generation honors explicit style and hero choices while preserving legacy defaults (choices=%s)', async explicit => {
  const files = new WorldFiles('w');
  files.write(files.path('drawings', 'dragon.png'), 'cached-drawing');
  files.write(files.path('drawings', 'owl.png'), 'cached-drawing');
  files.write(files.path('drawings.json'), [
    { file: 'dragon.png', key: 'dragon', kind: 'hero', looks: 'a white dragon' },
    { file: 'owl.png', key: 'owl', kind: 'npc', looks: 'a round owl' },
  ]);
  const choices: CreativeChoices = { answers: [{ question: 'Kto jest bohaterem?', answer: 'Sowa' }], style: 'Thin black pencil lines on cream paper, original uneven proportions.' };
  if (explicit) files.write(files.path('creative-brief.json'), { idea: 'The owl delivers a letter.', choices });
  const lead = explicit ? 'owl' : 'dragon', other = explicit ? 'dragon' : 'owl';
  const designed: World = { title: 'Home', pitch: 'A letter to deliver.', style: 'generic generated watercolor', start: 'home', hero: { key: lead, looks: 'a drawn character' }, places: [
    { key: 'home', shows: 'A little house', mood: 'sunny', exits: [], things: [{ key: other, role: 'npc', looks: 'a drawn friend' }] },
  ] };
  vi.mocked(designWorld).mockImplementation(async (_memo, _idea, _places, _room, extra) => {
    expect(extra?.issues(designed)).toEqual([]);
    expect(extra?.brief).toContain(explicit ? choices.style : KIDS_STYLE);
    if (explicit) {
      expect(extra?.brief).toContain('according to the creator');
      expect(extra?.issues({ ...designed, hero: { key: 'invented', looks: 'someone new' } })).toEqual(['Choose the hero from the drawn characters: dragon, owl']);
    }
    return designed;
  });
  await registry.get('world')!.run(['w', explicit ? 'The owl delivers a letter. The creator chose the owl as hero.' : 'A dragon delivers a letter.']);
  const world = files.world();
  expect(world.hero.key).toBe(lead);
  expect(world.style).toBe(explicit ? choices.style : KIDS_STYLE);
  const drawings = files.readJson(files.path('drawings.json')) as Array<{ key: string; kind: string }>;
  expect(drawings.find(d => d.key === lead)?.kind).toBe('hero');
  expect(drawings.find(d => d.key === other)?.kind).toBe('npc');
});
