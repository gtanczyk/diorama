import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { shapeIdea } from '../src/actions/start.ts';
import { runAction, type ActionContext } from '../src/actions/registry.ts';
import { askSparkJson } from '../src/meta/spark.ts';
import { Memo } from '../src/meta/memo.ts';
import { Events } from '../src/studio/events.ts';
import { MAX_WORLD_PHOTOS } from '../src/world/photo-limits.ts';

vi.mock('../src/meta/spark.ts', () => ({ askSparkJson: vi.fn() }));
const ask = vi.mocked(askSparkJson);
const idea = 'Make a story from the children’s drawings';
const shape = { title: 'Forest post', slug: 'forest-post', places: 4, language: 'Polish' };
let root: string, memo: Memo;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-start-'));
  memo = new Memo(path.join(root, '.start', 'memo'));
  ask.mockReset();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('ideas without photos still accept the legacy response without pictures', async () => {
  ask.mockResolvedValue(shape);
  expect(await shapeIdea(memo, idea, [])).toEqual(shape);
  expect(ask).toHaveBeenCalledTimes(1);
});

test.each([undefined, ['drawing'], ['drawing', 'drawing', 'drawing'], ['hero', 'hero'], ['place', 'place']].map((pictures) => ({ pictures })))(
  'incomplete or ambiguous photo classifications are corrected before use: $pictures', async ({ pictures }) => {
    const images = [Buffer.from('first'), Buffer.from('second')];
    ask.mockResolvedValueOnce({ ...shape, pictures }).mockResolvedValueOnce({ ...shape, pictures: ['drawing', 'drawing'] });
    expect((await shapeIdea(memo, idea, images)).pictures).toEqual(['drawing', 'drawing']);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[1][1].images).toEqual(images);
    expect(ask.mock.calls[1][1].prompt).toContain('Fix: pictures:');
  },
);

test('mixed photos keep their classifications in input order', async () => {
  const pictures = ['drawing', 'hero', 'none', 'place', 'drawing'];
  ask.mockResolvedValue({ ...shape, pictures });
  expect((await shapeIdea(memo, idea, pictures.map(() => Buffer.from('photo')))).pictures).toEqual(pictures);
});

async function input(count: number) {
  const image = await sharp({ create: { width: 12, height: 12, channels: 3, background: 'white' } }).png().toBuffer();
  return { idea, photos: Array.from({ length: count }, (_, i) => ({ name: `drawing-${i + 1}.png`, data: image.toString('base64') })) };
}
function context() {
  const start = vi.fn().mockResolvedValue({ id: 'test-job' });
  const ctx = { root, by: 'user', events: new Events(), jobs: { start } } as unknown as ActionContext;
  return { ctx, start };
}

test.each([18, MAX_WORLD_PHOTOS])('world_new preserves all %i drawings before starting its job', async (count) => {
  ask.mockResolvedValue({ ...shape, pictures: Array(count).fill('drawing') });
  const { ctx, start } = context();
  const result = await runAction('world_new', await input(count), ctx);
  expect(result).toMatchObject({ drawings: count, slug: 'forest-post' });
  const files = fs.readdirSync(path.join(root, 'forest-post', 'drawings')).sort();
  expect(files).toHaveLength(count);
  expect(files[0]).toBe('01-drawing-1.png');
  expect(files.at(-1)).toBe(`${count}-drawing-${count}.png`);
  expect(start).toHaveBeenCalledTimes(1);
});

test('a repeatedly incomplete model response cannot create a partial world or launch a build', async () => {
  ask.mockResolvedValue({ ...shape, pictures: ['drawing'] });
  const { ctx, start } = context();
  await expect(runAction('world_new', await input(18), ctx)).rejects.toThrow(/all 18 photos.*after 3 attempts/);
  expect(ask).toHaveBeenCalledTimes(3);
  // Each repair has a fresh prompt, so a cached invalid reply cannot consume the next retry.
  expect(new Set(ask.mock.calls.map(([, request]) => request.prompt)).size).toBe(3);
  expect(start).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(root, 'forest-post'))).toBe(false);
});

test('the API rejects more than the shared limit before calling any model or starting a job', async () => {
  const { ctx, start } = context();
  await expect(runAction('world_new', await input(MAX_WORLD_PHOTOS + 1), ctx)).rejects.toThrow(/at most 32/);
  expect(ask).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});
