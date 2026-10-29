import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { buildModel, buildModels } from '../src/commands/model.ts';
import { worldData } from '../src/commands/play.ts';
import { WorldFiles } from '../src/world/files.ts';
import { reconstruct, autoRig } from '../src/model/build.ts';
import { paintViews } from '../src/model/views.ts';
import { fitViews } from '../src/model/fit.ts';
import { boxGlb } from './fixtures/model-box.ts';
import { scene } from './fixtures/scene.ts';

vi.mock('../src/model/build.ts', () => ({ reconstruct: vi.fn(), autoRig: vi.fn() }));
vi.mock('../src/model/views.ts', () => ({ paintViews: vi.fn() }));
vi.mock('../src/model/fit.ts', () => ({ fitViews: vi.fn(), refitIfOld: vi.fn() }));
let root: string, files: WorldFiles;
const valid = boxGlb([1.2, 1, 0.4]), flat = boxGlb([1, 0.043, 1]);
beforeEach(async () => {
  vi.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-model-gate-'));
  await scene(root);
  files = new WorldFiles('w', root);
  files.write(files.path('cast', 'hero.png'), Buffer.from('existing cutout'));
  files.write(files.path('cast', 'hero-painting.png'), Buffer.from('existing painting'));
  files.write(files.path('cast', 'figures.json'), { hero: { height: 0.6, upright: false } });
  files.write(files.path('cast', 'hero', 'model', 'model.glb'), flat);
  files.write(files.path('cast', 'hero', 'model', 'model.json'), { glb: 'model.glb', creature: true });
  vi.mocked(paintViews).mockResolvedValue({ front: Buffer.from('f'), back: Buffer.from('b'), left: Buffer.from('l'), right: Buffer.from('r') });
  vi.mocked(fitViews).mockResolvedValue({} as Awaited<ReturnType<typeof fitViews>>);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('an old flat model is excluded from game data while its animated 2D cutout stays available', () => {
  files.write(files.path('cast', 'hero', 'sprites', 'sprites.json'), {});
  const cast = worldData(files).cast.hero;
  expect(cast).toMatchObject({ image: 'cast/hero.png', upright: false });
  expect(cast).not.toHaveProperty('model');
  expect(cast).not.toHaveProperty('sprites');
});

test('bad reconstruction is retried, then a valid body is accepted', async () => {
  vi.mocked(reconstruct).mockResolvedValueOnce(flat).mockResolvedValueOnce(valid);
  await buildModel(files, 'hero', 0, '');
  expect(reconstruct).toHaveBeenCalledTimes(2);
  expect(fitViews).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(files.path('cast', 'hero', 'model', 'model.glb'))).toEqual(valid);
  expect(worldData(files).cast.hero).toHaveProperty('model');
});

test('exhausted reconstructions deactivate the older model and skip fitting', async () => {
  vi.mocked(reconstruct).mockResolvedValue(flat);
  await buildModel(files, 'hero', 0, '');
  expect(reconstruct).toHaveBeenCalledTimes(4);
  expect(fitViews).not.toHaveBeenCalled();
  expect(fs.existsSync(files.path('cast', 'hero', 'model', 'model.json'))).toBe(false);
  expect(fs.existsSync(files.path('cast', 'hero', 'model', 'model-rejected.json'))).toBe(true);
  expect(worldData(files).cast.hero).not.toHaveProperty('model');
});

test('an explicitly supplied flat model is refused before paid generation starts', async () => {
  const supplied = path.join(root, 'supplied.glb'); fs.writeFileSync(supplied, flat);
  await expect(buildModel(files, 'hero', 0, supplied)).rejects.toThrow('supplied 3D model rejected');
  expect(paintViews).not.toHaveBeenCalled();
  expect(reconstruct).not.toHaveBeenCalled();
});

test('a body flattened by auto-rigging is not published', async () => {
  files.write(files.path('cast', 'figures.json'), { hero: { height: 1.6, upright: true } });
  vi.mocked(reconstruct).mockResolvedValue(valid);
  vi.mocked(autoRig).mockResolvedValue(flat);
  await buildModel(files, 'hero', 0, '');
  expect(autoRig).toHaveBeenCalledTimes(1);
  expect(fitViews).not.toHaveBeenCalled();
  expect(fs.existsSync(files.path('cast', 'hero', 'model', 'model.json'))).toBe(false);
});

test('a failed hero upload does not skip the next character, and the batch reports the failure', async () => {
  const world = files.world();
  world.places[0].things.push({ key: 'owl', role: 'npc', looks: 'a round white owl' });
  files.write(files.path('world.json'), world);
  files.write(files.path('cast', 'owl-painting.png'), Buffer.from('owl painting'));
  files.write(files.path('cast', 'figures.json'), { hero: { height: 0.6, upright: false }, owl: { height: 0.4, upright: false } });
  vi.mocked(reconstruct).mockRejectedValueOnce(new Error('TRELLIS upload: HTTP 500')).mockResolvedValue(valid);
  await expect(buildModels(files, ['hero', 'owl'], 0, '')).rejects.toThrow('hero: TRELLIS upload: HTTP 500');
  expect(fs.existsSync(files.path('cast', 'owl', 'model', 'model.json'))).toBe(true);
  expect(files.readJson(files.path('cast', 'hero', 'model', 'attempt.json'))).toMatchObject({ state: 'failed', reason: 'TRELLIS upload: HTTP 500' });
  expect(files.readJson(files.path('cast', 'owl', 'model', 'attempt.json'))).toMatchObject({ state: 'ready', reason: null });
});

test('an explicit animate request fails honestly when all models are rejected, while a batch allows 2D fallback', async () => {
  vi.mocked(reconstruct).mockResolvedValue(flat);
  await expect(buildModels(files, ['hero'], 0, '', true)).rejects.toThrow('no usable 3D model');
  expect(files.readJson(files.path('cast', 'hero', 'model', 'attempt.json'))).toMatchObject({ state: 'fallback', reason: 'every reconstruction was flat or invalid' });
  await expect(buildModels(files, ['hero'], 0, '')).resolves.toBeUndefined();
});
