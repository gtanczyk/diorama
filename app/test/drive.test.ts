import sharp from 'sharp';
import { expect, test } from 'vitest';
import { DRIVE_FADE, driveBands } from '../src/scene/drive.ts';
import { FRAME } from '../src/scene/layout.ts';

test('driveBands: rows become bands far to near, each repeating and faster nearer', async () => {
  const { width: W, height: H } = FRAME;
  const raw = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) raw[(y * W + x) * 3] = (x * 7 + y) & 255;
  const png = await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  const bands = await driveBands(png, undefined, 400);
  expect(bands.length).toBeGreaterThan(4);
  for (let i = 1; i < bands.length; i++) {
    expect(bands[i].speed).toBeGreaterThan(bands[i - 1].speed);
    expect(bands[i].top).toBeGreaterThanOrEqual(bands[i - 1].bottom);
  }
  expect(bands.at(-1)!.speed).toBeLessThanOrEqual(1);
  const meta = await sharp(bands[0].png).metadata();
  expect(meta.width).toBe(W - DRIVE_FADE);
  expect(bands[0].top).toBe(0);
  expect(bands.at(-1)!.bottom).toBe(H);
});
