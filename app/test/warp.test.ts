import { describe, expect, it } from 'vitest';
import { emptyMask } from '../src/image/mask.ts';
import { rectMask } from '../src/image/raster.ts';
import type { Rig } from '../src/play/rig.ts';
import { checkSheet } from '../src/scene/rig-check.ts';
import { fillHoles, labelPixels, Part, warpSheet } from '../src/scene/warp.ts';

// A blocky figure in a long coat: body and coat down to the shins, two legs and boots below the hem.
const W = 200;
const H = 300;
const body = rectMask(W, H, [70, 20, 130, 230]);
const nearLeg = rectMask(W, H, [75, 150, 95, 270]);
const farLeg = rectMask(W, H, [105, 150, 125, 270]);
const nearBoot = rectMask(W, H, [72, 270, 100, 290]);
const farBoot = rectMask(W, H, [102, 270, 130, 290]);
const rig: Rig = {
  size: [W, H], ground: 290, height: 270, hip: [100, 150],
  shoulder: { near: [80, 50], far: [120, 50] },
  leg: { near: { knee: [85, 215], ankle: [85, 272] }, far: { knee: [115, 215], ankle: [115, 272] } },
  parts: [],
};

describe('warp walk', () => {
  it('walks a long-coated figure without holes or loose parts', async () => {
    const silhouette = emptyMask(W, H);
    for (const m of [body, nearLeg, farLeg, nearBoot, farBoot]) m.bits.forEach((b, i) => b && (silhouette.bits[i] = 1));
    const labels = labelPixels(silhouette, [[Part.Body, body], [Part.FarLeg, farLeg], [Part.NearLeg, nearLeg], [Part.FarBoot, farBoot], [Part.NearBoot, nearBoot]]);
    const image = Buffer.alloc(W * H * 4);
    silhouette.bits.forEach((b, i) => b && image.set([labels[i] * 30, 90, 140, 255], i * 4));
    const sheet = await warpSheet(rig, image, labels, { px: 270 });
    const check = await checkSheet({ ...rig, sheet: { file: 'walk.png', cols: sheet.cols, rows: sheet.rows, frames: sheet.frames, cell: sheet.cell, scale: sheet.scale } }, sheet.png);
    expect(check.ok).toBe(true);
  });

  it('fills a hole the mask closes round', () => {
    const ring = rectMask(50, 50, [10, 10, 40, 40]);
    rectMask(50, 50, [20, 20, 30, 30]).bits.forEach((b, i) => b && (ring.bits[i] = 0));
    expect(fillHoles(ring).bits[25 * 50 + 25]).toBe(1);
    expect(fillHoles(ring).bits[5 * 50 + 5]).toBe(0);
  });
});
