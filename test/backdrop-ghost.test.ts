import { expect, test } from 'vitest';
import { ghostOf } from '../src/scene/backdrop.ts';
import { rectMask } from '../src/image/raster.ts';

const W = 200;
const H = 200;
/** A sky-to-floor gradient, the kind of background a removal should continue. */
function scene(): Uint8Array {
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) rgb.fill(120 + Math.round((i / W) * 0.4), i * 3, i * 3 + 3);
  return rgb;
}

test('a removed thing that left its dark silhouette is a ghost; a background that continues is not', () => {
  const area = rectMask(W, H, [70, 40, 130, 180]);
  const clean = scene();
  expect(ghostOf(clean, W, H, area).ghost).toBe(false);
  const ghost = scene();
  for (let i = 0; i < W * H; i++) if (area.bits[i]) for (let c = 0; c < 3; c++) ghost[i * 3 + c] -= 45;
  expect(ghostOf(ghost, W, H, area)).toMatchObject({ ghost: true });
});
