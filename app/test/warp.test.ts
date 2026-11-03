import { describe, expect, it } from 'vitest';
import { emptyMask, maskArea } from '../src/image/mask.ts';
import { rectMask } from '../src/image/raster.ts';
import type { Rig } from '../src/play/rig.ts';
import { checkSheet } from '../src/scene/rig-check.ts';
import { fillHoles, labelPixels, Part, silhouette, warpSheet } from '../src/scene/warp.ts';

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

describe('silhouette', () => {
  const [W, H] = [120, 160];
  const paint = (rects: Array<[[number, number, number, number], [number, number, number]]>) => {
    const rgba = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) rgba.set([200, 200, 200, 255], i * 4);
    for (const [[x0, y0, x1, y1], c] of rects) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) rgba.set([...c, 255], (y * W + x) * 4);
    return rgba;
  };
  // A person 20 px wide, legs apart below y 100.
  const legs = [[50, 30, 70, 100], [50, 100, 57, 140], [63, 100, 70, 140], [50, 140, 70, 145]] as const;
  const person = emptyMask(W, H);
  for (const r of legs) rectMask(W, H, [...r]).bits.forEach((b, i) => b && (person.bits[i] = 1));
  const body = legs.map((r) => [[...r], [40, 120, 40]] as [[number, number, number, number], [number, number, number]]);

  it('keeps a lantern they hold', () => {
    const out = silhouette(paint([...body, [[70, 80, 80, 95], [250, 200, 60]]]), person);
    expect(out.bits[85 * W + 75]).toBe(1);
  });

  it('leaves out the framed scene they were painted standing in, and the scene between their legs', () => {
    const out = silhouette(paint([[[20, 10, 100, 150], [30, 50, 110]], ...body]), person);
    expect(out.bits[60 * W + 30]).toBe(0);
    expect(out.bits[120 * W + 60]).toBe(0);
    expect(out.bits[60 * W + 60]).toBe(1);
    expect(maskArea(out)).toBe(maskArea(person));
  });
});
