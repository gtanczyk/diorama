import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { expect, test } from 'vitest';
import { rectMask } from '../src/image/raster.ts';
import { carryFrom, MOST, paintingFor, ran, reaches, seedRan, withChange } from '../src/scene/carry.ts';
import { pasteRegions } from '../src/scene/critic.ts';
import { FRAME } from '../src/scene/layout.ts';

const { width: W, height: H } = FRAME;
const solid = (colour: string) => sharp({ create: { width: W, height: H, channels: 3, background: colour } }).png().toBuffer();

test('a small repaint carries what it does not reach; a new painting carries nothing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-'));
  const before = await solid('#203040');
  expect(await carryFrom(dir, 'masks', before)).toBeUndefined();
  ran(dir, 'masks', before);
  ran(dir, 'derive', before);
  // Steps that ran on the same painting share one file.
  expect(fs.statSync(path.join(dir, '.ran', 'derive.png')).ino).toBe(fs.statSync(path.join(dir, '.ran', 'masks.png')).ino);
  expect(await carryFrom(dir, 'masks', before)).toBeUndefined();

  const after = await pasteRegions(before, await solid('#ffcc00'), [[100, 100, 220, 200]]);
  const carry = (await carryFrom(dir, 'masks', after))!;
  expect(carry.old.equals(before)).toBe(true);
  expect(carry.share).toBeGreaterThan(0);
  expect(carry.share).toBeLessThan(0.05);
  // A lamp at the repaint is asked again; a boat across the frame keeps its answer.
  expect(reaches(carry, rectMask(W, H, [150, 150, 180, 190]))).toBe(true);
  expect(reaches(carry, rectMask(W, H, [800, 500, 900, 600]))).toBe(false);
  expect(reaches(carry, [[800, 500, 900, 600], undefined])).toBe(false);
  expect(reaches(carry, [[800, 500, 900, 600], [210, 190, 260, 260]])).toBe(true);
  expect(paintingFor(carry, after, [800, 500, 900, 600])).toBe(carry.old);
  expect(paintingFor(carry, after, [150, 150, 180, 190])).toBe(after);
  expect(paintingFor(undefined, after, [800, 500, 900, 600])).toBe(after);

  // Something made from the old painting gets the repainted tiles from the new one.
  const made = await withChange(before, after, carry);
  const [m, a] = await Promise.all([made, after].map((b) => sharp(b).removeAlpha().raw().toBuffer()));
  expect(m.equals(a)).toBe(true);

  const repainted = await solid('#ffffff');
  expect(MOST).toBeLessThan(1);
  expect(await carryFrom(dir, 'masks', repainted)).toBeUndefined();
});

test('a place built before the steps kept their painting carries on its first repaint', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-'));
  const before = await solid('#203040');
  fs.writeFileSync(path.join(dir, 'painting.png'), before);
  // masks and derive ran on this painting; plates never ran.
  fs.writeFileSync(path.join(dir, 'masks.json'), '{}');
  fs.writeFileSync(path.join(dir, 'geometry.json'), '{}');
  seedRan(dir);
  expect(fs.existsSync(path.join(dir, '.ran', 'masks.png'))).toBe(true);
  expect(fs.existsSync(path.join(dir, '.ran', 'derive.png'))).toBe(true);
  expect(fs.existsSync(path.join(dir, '.ran', 'plates.png'))).toBe(false);
  const after = await pasteRegions(before, await solid('#ffcc00'), [[100, 100, 220, 200]]);
  expect((await carryFrom(dir, 'masks', after))?.old.equals(before)).toBe(true);
});
