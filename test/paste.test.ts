import sharp from 'sharp';
import { expect, test } from 'vitest';
import { emptyMask } from '../src/image/mask.ts';
import { pasteRegions } from '../src/scene/critic.ts';
import { FRAME } from '../src/scene/layout.ts';
import { pasteInside } from '../src/scene/plates.ts';

const { width: W, height: H } = FRAME;
const solid = (colour: string, width: number = W, height: number = H) => sharp({ create: { width, height, channels: 3, background: colour } }).png().toBuffer();
const red = (raw: Buffer, x: number, y: number) => raw[(y * W + x) * 4];

test('an edit lands only inside its region or mask; the rest of the painting stays exactly as it was', async () => {
  const painting = await solid('#000000');
  // Muse answers at another size: it is fitted to the frame first.
  const patched = await solid('#ff0000', 1712, 1280);
  const byRegion = await sharp(await pasteRegions(painting, patched, [[100, 100, 300, 300]])).ensureAlpha().raw().toBuffer();
  expect(red(byRegion, 200, 200)).toBeGreaterThan(240);
  expect(red(byRegion, 600, 600)).toBe(0);
  expect(red(byRegion, 50, 200)).toBe(0);
  const mask = emptyMask(W, H);
  for (let y = 400; y < 500; y++) mask.bits.fill(1, y * W + 700, y * W + 800);
  const byMask = await sharp(await pasteInside(painting, patched, mask)).ensureAlpha().raw().toBuffer();
  expect(red(byMask, 750, 450)).toBeGreaterThan(240);
  expect(red(byMask, 200, 200)).toBe(0);
});
