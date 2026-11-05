import sharp from 'sharp';
import { expect, test } from 'vitest';
import { driveLayers } from '../src/scene/drive.ts';
import { FRAME } from '../src/scene/layout.ts';

test('driveLayers: below the horizon streams, the sky stays, and the far view is filled where the near stood', async () => {
  const { width: W, height: H } = FRAME;
  const raw = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) raw.set(y < 400 ? [120, 170, 230] : [90, 90, 90], (y * W + x) * 3);
  const png = await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  const made = await driveLayers(png, undefined, 400, 610);
  expect(made.vp).toEqual([610, 400]);
  const near = await sharp(made.near).raw().toBuffer({ resolveWithObject: true });
  expect(near.info.channels).toBe(4);
  expect(near.data[(100 * W + 600) * 4 + 3]).toBe(0);
  expect(near.data[(700 * W + 600) * 4 + 3]).toBe(255);
});
