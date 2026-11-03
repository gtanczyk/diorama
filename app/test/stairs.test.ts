import sharp from 'sharp';
import { expect, test } from 'vitest';
import { maskBox, rectMask } from '../src/image/raster.ts';
import { FRAME } from '../src/scene/layout.ts';
import { treadBands } from '../src/scene/stairs.ts';

const { width: W, height: H } = FRAME;

/** A painting of `n` steps from y0, each `h` tall: a light tread 6 px deep over a dark riser. */
async function stairsPainting(y0: number, n: number, h: number): Promise<Buffer> {
  const rgb = Buffer.alloc(W * H * 3, 90);
  for (let k = 0; k < n; k++) {
    for (let y = y0 + k * h; y < y0 + (k + 1) * h; y++) {
      const v = y - (y0 + k * h) < 6 ? 170 : 40;
      for (let x = 100; x < 300; x++) rgb.fill(v, (y * W + x) * 3, (y * W + x) * 3 + 3);
    }
  }
  return sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

test('steps SAM cannot find are read off the lit edges of their treads', async () => {
  const stairs = rectMask(W, H, [100, 500, 300, 600]);
  const bands = await treadBands(await stairsPainting(500, 4, 25), stairs);
  const tops = bands.map((b) => maskBox(b)![1]);
  expect(tops.length).toBe(4);
  [500, 525, 550, 575].forEach((y, k) => expect(Math.abs(tops[k] - y)).toBeLessThanOrEqual(1));
  expect(bands.every((b) => { const box = maskBox(b)!; return box[3] - box[1] >= 23 && box[3] - box[1] <= 26; })).toBe(true);
});

test('a plain block or a slope has no treads: the stairs stay a ramp', async () => {
  const stairs = rectMask(W, H, [100, 500, 300, 600]);
  expect(await treadBands(await stairsPainting(500, 1, 100), stairs)).toEqual([]);
  const flat = await sharp({ create: { width: W, height: H, channels: 3, background: '#5a5a5a' } }).png().toBuffer();
  expect(await treadBands(flat, stairs)).toEqual([]);
});
