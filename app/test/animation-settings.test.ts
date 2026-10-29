import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { animationOptions, animationSettings, saveAnimationSettings } from '../src/model/animation.ts';
import { modelSheet } from '../src/model/sprites.ts';
import { WorldFiles } from '../src/world/files.ts';
const dirs: string[] = [];
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'animation-settings-')); dirs.push(root); return new WorldFiles('world', root); }
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
test('legacy characters stay painted with eight frames; opting into UV starts with sixteen', () => {
  const files = fixture();
  expect(animationSettings(files, 'hero')).toEqual({ texture: 'views', frames: 8 });
  expect(animationSettings(files, 'hero', { texture: 'model' })).toEqual({ texture: 'model', frames: 16 });
});
test('choices survive removal of generated outputs and remain local to one character', () => {
  const files = fixture();
  saveAnimationSettings(files, 'hero', { texture: 'model', frames: 32 });
  files.write(files.path('cast', 'hero', 'model', 'model.json'), {});
  files.write(files.path('cast', 'hero', 'sprites', 'sprites.json'), {});
  fs.rmSync(files.path('cast', 'hero', 'model'), { recursive: true });
  fs.rmSync(files.path('cast', 'hero', 'sprites'), { recursive: true });
  expect(animationSettings(files, 'hero')).toEqual({ texture: 'model', frames: 32 });
  expect(animationSettings(files, 'other')).toEqual({ texture: 'views', frames: 8 });
  expect(animationSettings(files, 'hero', { texture: 'views' })).toEqual({ texture: 'views', frames: 8 });
});
test('unsupported counts and painted high-frame sheets fail explicitly', () => {
  const files = fixture();
  for (const value of ['0', '17', 'NaN', '16.5']) expect(() => animationOptions('model', value)).toThrow();
  expect(() => animationOptions('unknown')).toThrow();
  expect(() => animationSettings(files, 'hero', { frames: 16 })).toThrow('use --texture model');
});
test.each([8, 16, 32])('a %i-frame UV sheet reserves standing without changing cell size', (frames) => {
  const grid = modelSheet(frames);
  expect(grid.frames).toBe(frames);
  expect(grid.rows * grid.cols).toBeGreaterThan(frames);
  expect(grid.width / grid.cols).toBe(300);
  expect(grid.height / grid.rows).toBe(448);
});

test('trousers keep their opt-out when changing frame count or regenerating', () => {
  const files = fixture();
  const chosen = animationSettings(files, 'bruno', animationOptions('model', '16', 'off'));
  saveAnimationSettings(files, 'bruno', chosen);
  expect(animationSettings(files, 'bruno', { frames: 32 })).toEqual({ texture: 'model', frames: 32, coatCorrection: false });
  expect(animationSettings(files, 'mara')).not.toHaveProperty('coatCorrection');
  expect(() => animationOptions('model', '', 'false')).toThrow();
});
