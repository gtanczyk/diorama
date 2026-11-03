import sharp from 'sharp';
import { expect, test } from 'vitest';
import { emptyMask, maskArea } from '../src/image/mask.ts';
import { dilate, rectMask } from '../src/image/raster.ts';
import { pasteRegions, wholeRegions } from '../src/scene/critic.ts';
import { FRAME } from '../src/scene/layout.ts';
import { pasteInside, withAttached } from '../src/scene/plates.ts';

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

test('a part SAM left out of the mask (a rope off a bucket) joins the patch when Muse removed it too', async () => {
  // The painting: a bucket (in the mask) and a rope tail going off it to the right (not in the mask).
  const painting = await sharp(await solid('#5a646e')).composite([
    { input: await solid('#dcdcdc', 60, 60), left: 500, top: 400 },
    { input: await solid('#c8963c', 50, 6), left: 560, top: 440 },
  ]).png().toBuffer();
  const mask = rectMask(W, H, [500, 400, 560, 460]);
  const area = dilate(mask, 4);
  // Muse's edit: all ground, a touch darker, with a stone far away that is not the thing's.
  const edited = await sharp(await solid('#545e68')).composite([{ input: await solid('#fafafa', 20, 20), left: 100, top: 100 }]).png().toBuffer();
  const grown = await withAttached(painting, edited, mask, area);
  expect(grown.bits[443 * W + 600]).toBe(1);
  expect(grown.bits[110 * W + 110]).toBe(0);
  expect(maskArea(grown)).toBeLessThan(maskArea(area) + 60 * 14 + 400);
});

test('a boat Muse painted on past its region is pasted whole, not cut at the region edge into the sea', async () => {
  const { wholeRegions } = await import('../src/scene/critic.ts');
  const sea = await solid('#20407a');
  // Muse moved the boat right: it runs from x 700 to 1090, the region asked for ends at 960.
  const boat = await sharp(await solid('#20407a')).composite([{ input: await solid('#7a5a3a', 390, 100), left: 700, top: 680 }]).png().toBuffer();
  const [grown] = await wholeRegions(sea, boat, [[690, 665, 960, 800]]);
  expect(grown[2]).toBeGreaterThanOrEqual(1090);
  expect(grown[2]).toBeLessThanOrEqual(1130);
  // The sea above and below changed nowhere: those sides stay.
  expect(grown[1]).toBe(665);
  expect(grown[3]).toBe(800);
  const pasted = await sharp(await pasteRegions(sea, boat, [[690, 665, 960, 800]])).ensureAlpha().raw().toBuffer();
  expect(red(pasted, 1060, 730)).toBeGreaterThan(110);
});

test('a critic repaint Muse painted past its region is grown to take all of it, or left out when it runs far on', async () => {
  const { critiqueRegions } = await import('../src/scene/critic.ts');
  const painting = await solid('#404040');
  const patch = async (w: number) => sharp(painting).composite([{ input: await solid('#d0a060', w, 100), left: 100, top: 100 }]).png().toBuffer();
  const a = await patch(130);
  // Steps painted 30 px past the box: the box grows to them, and they are pasted whole.
  const near = await critiqueRegions(painting, a, [[100, 100, 200, 200]]);
  expect(near.dropped).toEqual([]);
  expect(near.kept[0][2]).toBeGreaterThanOrEqual(230);
  expect(near.kept[0][2]).toBeLessThanOrEqual(248);
  // A staircase 300 px past the box would be sliced at any edge: the painting keeps what it had.
  const far = await critiqueRegions(painting, await patch(400), [[100, 100, 200, 200]]);
  expect(far.kept).toEqual([]);
  expect(far.dropped).toEqual([[100, 100, 200, 200]]);
  // A repaint that stays inside its region is taken as asked.
  const inside = await critiqueRegions(painting, await patch(90), [[96, 96, 200, 208]]);
  expect(inside.kept).toEqual([[96, 96, 200, 208]]);
});
