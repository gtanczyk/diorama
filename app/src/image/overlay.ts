// Review pictures: masks tinted over the painting, so a person sees at a glance what a step found.
import sharp from 'sharp';
import type { Mask } from './mask.ts';

export type Tint = { mask: Mask; rgb: [number, number, number]; alpha?: number };

/** Distinct, readable colours for up to a dozen layers; they repeat after that. */
export const PALETTE: [number, number, number][] = [
  [255, 70, 70], [70, 200, 255], [255, 210, 40], [170, 90, 255], [60, 230, 120], [255, 130, 200],
  [255, 140, 30], [40, 120, 255], [200, 255, 60], [0, 200, 180], [230, 60, 160], [150, 150, 255],
];

/** Tints each mask over the painting; a mask's edge pixels are drawn solid. */
export async function tintOver(painting: Buffer, tints: Tint[], extraSvg = ''): Promise<Buffer> {
  const { data, info } = await sharp(painting).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;
  const out = Buffer.from(data);
  for (const { mask, rgb, alpha = 0.45 } of tints) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!mask.bits[i]) continue;
        const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1 || !mask.bits[i - 1] || !mask.bits[i + 1] || !mask.bits[i - W] || !mask.bits[i + W];
        const a = edge ? 1 : alpha;
        for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(out[i * 3 + c] * (1 - a) + rgb[c] * a);
      }
    }
  }
  const img = sharp(out, { raw: { width: W, height: H, channels: 3 } });
  const svg = extraSvg && `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${extraSvg}</svg>`;
  return (svg ? img.composite([{ input: Buffer.from(svg) }]) : img).png().toBuffer();
}

/** Labels for an overlay, drawn with a dark outline so they read on any painting. */
export function svgLabel(x: number, y: number, text: string, rgb: [number, number, number] = [255, 255, 255]): string {
  const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<text x="${x}" y="${y}" font-family="sans-serif" font-size="15" font-weight="bold" fill="rgb(${rgb.join(',')})" stroke="#000" stroke-width="3" paint-order="stroke">${safe}</text>`;
}
