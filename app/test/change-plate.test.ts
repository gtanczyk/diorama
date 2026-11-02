import { expect, test } from 'vitest';
import { emptyMask, type Mask } from '../src/image/mask.ts';
import { changeAlpha } from '../src/scene/plates.ts';
import { FRAME } from '../src/scene/layout.ts';

const box = (x0: number, y0: number, x1: number, y1: number): Mask => {
  const m = emptyMask(FRAME.width, FRAME.height);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m.bits[y * FRAME.width + x] = 1;
  return m;
};

test('a change plate shows around its thing but keeps off the other things near it', async () => {
  const basket = box(650, 450, 810, 600);
  const ticket = box(655, 605, 730, 640);
  const alone = await changeAlpha(basket, []);
  const at = (a: Buffer, x: number, y: number) => a[y * FRAME.width + x];
  expect(at(alone, 690, 620)).toBeGreaterThan(200);
  const kept = await changeAlpha(basket, [ticket]);
  expect(at(kept, 690, 620)).toBe(0);
  expect(at(kept, 700, 500)).toBe(255);
  // Overlapping the changed thing itself, the change still wins.
  const kept2 = await changeAlpha(basket, [box(700, 500, 720, 520)]);
  expect(at(kept2, 710, 510)).toBe(255);
  expect(at(kept, 790, 615)).toBeGreaterThan(100);
});
