import sharp from 'sharp';
import { expect, test } from 'vitest';
import { emptyMask } from '../src/image/mask.ts';
import { FALLING, STREAM, streamSheet } from '../src/scene/layers.ts';
import { FRAME } from '../src/scene/layout.ts';

test('small things painted falling are a stream, not a waterfall', () => {
  expect(STREAM.test('falling-letters falling green code curtains of green falling letters and symbols')).toBe(true);
  expect(STREAM.test('code rain')).toBe(true);
  expect(STREAM.test('snowflakes falling past the window')).toBe(true);
  expect(STREAM.test('waterfall')).toBe(false);
  expect(STREAM.test('autumn tree with red leaves')).toBe(false);
  expect(FALLING.test('waterfall')).toBe(true);
});

test('a stream cuts its glyphs out of the backdrop, also where SAM masked only the paint between them', async () => {
  const [W, H] = [FRAME.width, FRAME.height];
  const rgb = Buffer.alloc(W * H * 3, 20);
  // Bright green bars (glyphs) on a dark wall, in the top band.
  for (let y = 40; y < 300; y++) for (let x = 100; x < 600; x++) if (x % 40 < 6 && y % 30 < 18) rgb[(y * W + x) * 3 + 1] = 230;
  const png = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  // SAM's mask: the wall between the glyphs, not the glyphs.
  const mask = emptyMask(W, H);
  for (let y = 30; y < 310; y++) for (let x = 90; x < 610; x++) if (!(x % 40 < 6 && y % 30 < 18)) mask.bits[y * W + x] = 1;
  const s = await streamSheet(png, mask);
  expect(s).toBeDefined();
  const back = await sharp(s!.backdrop).raw().toBuffer();
  // The glyph is gone from the backdrop: the wall's paint is there now.
  expect(back[(45 * W + 122) * 3 + 1]).toBeLessThan(60);
  // ... and it is on the sheet, opaque.
  const { data, info } = await sharp(s!.png).raw().toBuffer({ resolveWithObject: true });
  const [x0, y0] = s!.box;
  expect(data[((45 - y0) * info.width + (122 - x0)) * 4 + 3]).toBeGreaterThan(200);
});
