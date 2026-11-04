import sharp from 'sharp';
import { expect, test } from 'vitest';
import { emptyMask, type Mask } from '../src/image/mask.ts';
import { cutOut } from '../src/scene/cast.ts';
import { bodyShare, heldThings } from '../src/scene/held.ts';
import type { Memo } from '../src/meta/memo.ts';

const W = 200, H = 300;
const rect = (m: Mask, x0: number, y0: number, x1: number, y1: number) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m.bits[y * W + x] = 1; return m; };

/** A small figure on a grey ground holding over its head a slab much wider than itself (a giant slice of toast). */
async function painting() {
  const px = Buffer.alloc(W * H * 3, 210);
  const paint = (m: Mask, rgb: number[]) => m.bits.forEach((b, i) => b && rgb.forEach((v, c) => (px[i * 3 + c] = v)));
  const person = rect(emptyMask(W, H), 85, 180, 115, 290);
  rect(person, 80, 150, 85, 182); rect(person, 115, 150, 120, 182);  // raised arms
  const toast = rect(emptyMask(W, H), 20, 20, 180, 151);
  paint(toast, [240, 170, 90]);
  paint(person, [200, 120, 60]);
  return { png: await sharp(px, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer(), person, toast };
}

const alphaRows = async (png: Buffer) => (await sharp(png).metadata()).height!;

test('a held thing bigger than its holder is dropped by the plain-ground cut, kept when SAM found it', async () => {
  const { png, person, toast } = await painting();
  const without = await cutOut(png, person);
  const kept = await cutOut(png, person, toast);
  expect(without.share).toBe(1);
  expect(kept.share).toBeLessThan(0.6);
  const a = await sharp(without.figure).metadata();
  const b = await sharp(kept.figure).metadata();
  // Same height (HERO_PX), but the cut with the toast is much wider: the slab is on it.
  expect(await alphaRows(without.figure)).toBe(await alphaRows(kept.figure));
  expect(b.width! / b.height!).toBeGreaterThan(2 * (a.width! / a.height!));
  expect(bodyShare(person, person)).toBe(1);
});

test('held things: the person\'s list wins, a description with nothing in hand costs no Spark call', async () => {
  const memo = { } as Memo;
  expect(await heldThings(memo, { key: 'k', looks: 'a keeper in a yellow oilskin', holds: [' slice of toast '] })).toEqual(['slice of toast']);
  expect(await heldThings(memo, { key: 'k', looks: 'a keeper in a yellow oilskin and boots' })).toEqual([]);
  expect(await heldThings(memo, { key: 'k', looks: 'anyone', holds: [] })).toEqual([]);
});
