import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { planSprites } from '../src/model/plan.ts';
import { askSparkJson } from '../src/meta/spark.ts';
import { Story } from '../src/story/schema.ts';
import { WorldFiles } from '../src/world/files.ts';
import { scene } from './fixtures/scene.ts';
vi.mock('../src/meta/spark.ts', () => ({ askSparkJson: vi.fn() }));
let root: string, files: WorldFiles;
beforeEach(async () => {
  vi.clearAllMocks(); root = fs.mkdtempSync(path.join(os.tmpdir(), 'sprite-plan-')); await scene(root); files = new WorldFiles('w', root);
  files.write(files.path('cast', 'hero', 'sprites', 'sprites.json'), { lines: { Hi: 'explain' } });
  files.write(files.path('cast', 'guard', 'sprites', 'sprites.json'), { lines: { Hello: 'listen' } });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function story(says = 'Hello') { return Story.parse({ intro: 'Welcome', items: [], interactions: [], dialogues: [{ place: 'room', npc: 'guard', start: 'hello', lines: [{ key: 'hello', says, choices: [{ text: 'Hi' }] }] }], endings: [{ key: 'done', title: 'Done', text: 'Finished' }] }); }
test('rerendering sheets keeps existing gestures without asking the planner', async () => {
  const plans = await planSprites(files, story());
  expect(plans.find((p) => p.key === 'hero')?.lines).toEqual({ Hi: 'explain' });
  expect(plans.find((p) => p.key === 'guard')?.lines).toEqual({ Hello: 'listen' });
  expect(askSparkJson).not.toHaveBeenCalled();
});
test('only new lines are sent for planning, without replacing known assignments', async () => {
  vi.mocked(askSparkJson).mockResolvedValue({ gestures: ['point'] });
  const plans = await planSprites(files, story('New line'));
  expect(plans.find((p) => p.key === 'hero')?.lines).toEqual({ Hi: 'explain' });
  expect(plans.find((p) => p.key === 'guard')?.lines).toEqual({ 'New line': 'point' });
  expect(askSparkJson).toHaveBeenCalledTimes(1);
  const prompt = vi.mocked(askSparkJson).mock.calls[0][1].prompt;
  expect(prompt).toContain('New line'); expect(prompt).not.toContain('hero: "Hi"');
});
test('walking NPCs get walk sheets even without spoken lines, while stationary NPCs keep talk only', async () => {
  const quiet = story();
  const stationary = await planSprites(files, quiet);
  expect(stationary.find((p) => p.key === 'guard')?.walk).toEqual([]);
  quiet.dialogues = [];
  quiet.patrols = [{ npc: 'guard', place: 'room', via: ['token', 'door'], when: [], pause: 2 }];
  const patrol = await planSprites(files, quiet);
  expect(patrol.find((p) => p.key === 'guard')?.walk.length).toBeGreaterThan(0);
  expect(patrol.find((p) => p.key === 'guard')?.talk).toEqual({});
  quiet.patrols = undefined;
  quiet.interactions = Story.parse({ ...quiet, interactions: [{ place: 'room', thing: 'token', verb: 'use', say: 'Go.', do: [{ moveNpc: { npc: 'guard', to: 'garden' } }] }] }).interactions;
  expect((await planSprites(files, quiet)).find((p) => p.key === 'guard')?.walk.length).toBeGreaterThan(0);
  expect(askSparkJson).not.toHaveBeenCalled();
});
