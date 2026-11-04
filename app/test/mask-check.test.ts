import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import '../src/commands/masks.ts';
import { registry } from '../src/registry.ts';
import { rectMask } from '../src/image/raster.ts';
import { checkMasks } from '../src/scene/maskcheck.ts';
import { autoFixes } from '../src/scene/autofix.ts';
import { readCorrections, writeCorrections } from '../src/scene/corrections.ts';
import { verifyPlace } from '../src/scene/verify.ts';
import { scene } from './fixtures/scene.ts';

vi.mock('../src/scene/locate.ts', async (original) => ({ ...await original<typeof import('../src/scene/locate.ts')>(), locateThings: async () => ({ token: { box: [490, 540, 510, 560], kind: 'on-top', phrase: 'red token' } }), markFloors: async () => ({ floor: ['A10'] }) }));
vi.mock('../src/scene/masks.ts', () => ({
  maskThings: async () => [{ key: 'token', kind: 'on-top', source: 'sam-box', coarse: false, box: [490, 540, 510, 560], mask: rectMask(1200, 896, [490, 540, 510, 560]) }],
  maskFloors: async () => [{ key: 'floor', source: 'sam-text', coarse: false, iouCells: 1, iouLayout: 1, mask: rectMask(1200, 896, [0, 240, 1200, 896]) }],
}));
vi.mock('../src/scene/maskcheck.ts', () => ({ checkMasks: vi.fn(async () => ({ token: { ok: false, seen: 'a grey stone', box: [490, 540, 510, 560] } })) }));
const cwd = process.cwd(); let root: string;
afterEach(() => { process.chdir(cwd); if (root) fs.rmSync(root, { recursive: true, force: true }); vi.clearAllMocks(); });

test('an automatic box correction cannot make the same wrong mask pass by removing its check', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-mask-check-'));
  const { world, geometry, put, dir } = await scene(path.join(root, 'worlds'));
  put('places/room/brief.json', { looks: { token: 'a round red token', floor: 'a wide beige floor' }, alive: [] });
  process.chdir(root);
  const run = () => registry.get('masks')!.run(['w', 'room']);
  const notes = () => JSON.parse(fs.readFileSync(path.join(dir, 'places/room/masks.json'), 'utf8'));
  await run();
  const before = verifyPlace(world.places[0], geometry, notes());
  const png = fs.readFileSync(path.join(dir, 'places/room/masks/token.png'));
  const fixes = readCorrections(path.join(dir, 'places/room'));
  for (const fix of autoFixes(geometry, ['floor'], before.errors)) fix.apply(fixes);
  writeCorrections(path.join(dir, 'places/room'), fixes);
  await run();
  expect(fs.readFileSync(path.join(dir, 'places/room/masks/token.png'))).toEqual(png);
  expect(verifyPlace(world.places[0], geometry, notes()).errors[0].code).toBe('MASK_WRONG');
  expect(checkMasks).toHaveBeenCalledTimes(2);
  vi.mocked(checkMasks).mockRejectedValueOnce(new Error('unavailable'));
  await expect(run()).rejects.toThrow('mask check failed');
});

test('a way out cut as its opening is not a wrong mask when Spark sees through it, inside the doorway it boxes', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-mask-check-'));
  const { world, geometry } = await scene(path.join(root, 'worlds'));
  const place = { ...world.places[0], things: [{ key: 'door', role: 'exit' as const, looks: 'a glowing doorway', to: 'room' }] };
  const thing = { key: 'door', role: 'exit' as const, kind: 'wall' as const, box: [108, 451, 317, 750] as [number, number, number, number], stand: [500, 620] as [number, number], mask: 'masks/door.png' };
  const notes = (box: [number, number, number, number]) => ({ things: { door: { coarse: false, source: 'sam-box', check: { ok: false, seen: 'a desk and servers seen through the doorway', box } } }, floors: { floor: { coarse: false, source: 'sam-text', iouLayout: 1 } } });
  const through = verifyPlace(place as never, { ...geometry, things: [thing] }, notes([45, 150, 362, 750]));
  expect(through.errors.map((e) => e.code)).not.toContain('MASK_WRONG');
  expect(through.flags.map((f) => f.code)).toContain('MASK_DOUBT');
  // Spark pointing somewhere else is still a wrong mask.
  expect(verifyPlace(place as never, { ...geometry, things: [thing] }, notes([700, 150, 1000, 750])).errors.map((e) => e.code)).toContain('MASK_WRONG');
});
