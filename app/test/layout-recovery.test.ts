import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { Memo } from '../src/meta/memo.ts';
import { askSparkJson } from '../src/meta/spark.ts';
import { layOut, layoutIssues, repairSmallBoxes, type Layout } from '../src/scene/layout.ts';
import { World } from '../src/world/schema.ts';
vi.mock('../src/meta/spark.ts', () => ({ askSparkJson: vi.fn() }));
const roots: string[] = [];
afterEach(() => { vi.resetAllMocks(); roots.splice(0).forEach((p) => fs.rmSync(p, { recursive: true, force: true })); });
const world = World.parse({ title: 'Kitchen', pitch: 'Find the recipe in the kitchen.', style: 'pencil drawing', start: 'kitchen', hero: { key: 'ola', looks: 'young girl' }, places: [{ key: 'kitchen', shows: 'a quiet kitchen', mood: 'warm', exits: [], things: [{ key: 'grandmother', role: 'npc', looks: 'grandmother' }, { key: 'recipe-tin', role: 'item', looks: 'recipe tin' }] }] });
const place = world.places[0];
const small: Layout = { horizon: 300, sky: '#eeeeee', ground: '#aaaaaa', floors: [{ key: 'floor', is: 'floor', colour: '#aaaaaa', outline: [[0, 300], [1200, 300], [1200, 896], [0, 896]] }], things: [
  { key: 'grandmother', x: 500, footY: 500, width: 36, height: 98, metres: 1.5, colour: '#d79a9a' },
  { key: 'recipe-tin', x: 340, footY: 640, width: 26, height: 26, metres: .2, colour: '#b5483f' },
], lights: [] };
function memo() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-recovery-')); roots.push(dir); return new Memo(dir); }

test('small kitchen boxes are repaired before spending another model attempt', async () => {
  vi.mocked(askSparkJson).mockResolvedValue(small);
  const result = await layOut(memo(), world, place);
  expect(result.things.map((t) => [t.width, t.height])).toEqual([[40, 98], [40, 40]]);
  expect(layoutIssues(result, place)).toEqual([]);
  expect(askSparkJson).toHaveBeenCalledTimes(1);
  expect(small.things[0].width).toBe(36);
});

test('resizing cannot bypass reach or frame checks, and photos are never resized', async () => {
  const unsafe = structuredClone(small); unsafe.things[1].footY = 30;
  expect(layoutIssues(repairSmallBoxes(unsafe), place).join(' ')).toMatch(/no floor|inside/);
  vi.mocked(askSparkJson).mockResolvedValue(small);
  await expect(layOut(memo(), world, place, Buffer.from('photo'))).rejects.toThrow(/40x40/);
  expect(askSparkJson).toHaveBeenCalledTimes(3);
});

test('an exhausted batch retains concrete errors and the next run starts a fresh feedback batch', async () => {
  const m = memo();
  const invalid = { ...small, things: [] };
  const prompts: string[] = [];
  vi.mocked(askSparkJson).mockImplementation(async (_memo, ask) => { prompts.push(ask.prompt); return invalid; });
  await expect(layOut(m, world, place)).rejects.toThrow(/grandmother is missing/);
  expect(askSparkJson).toHaveBeenCalledTimes(3);
  vi.mocked(askSparkJson).mockImplementation(async (_memo, ask) => { prompts.push(ask.prompt); return small; });
  await layOut(m, world, place);
  expect(new Set(prompts.slice(0, 3)).size).toBe(3);
  expect(prompts.slice(0, 3)).not.toContain(prompts[3]);
  expect(prompts[3]).toContain('Repair batch 2');
  expect(prompts[3]).toContain('grandmother is missing');
  await layOut(m, world, place);
  expect(prompts[4]).toBe(prompts[3]); // A successful retry can be served from the normal model cache.
});

test('transport errors preserve the same batch for resumption and guidance reaches the model', async () => {
  const m = memo();
  vi.mocked(askSparkJson).mockRejectedValueOnce(new Error('network unavailable')).mockResolvedValue(small);
  await expect(layOut(m, world, place, undefined, 'Leave space around the table.')).rejects.toThrow('network unavailable');
  await layOut(m, world, place, undefined, 'Leave space around the table.');
  const calls = vi.mocked(askSparkJson).mock.calls;
  expect(calls[0][1].prompt).toBe(calls[1][1].prompt);
  expect(calls[1][1].prompt).toContain('Leave space around the table.');
});
