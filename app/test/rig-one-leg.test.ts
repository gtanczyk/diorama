import sharp from 'sharp';
import { expect, test, vi } from 'vitest';
import type { Mask } from '../src/image/mask.ts';

const W = 120, H = 240;
const box = (x0: number, y0: number, x1: number, y1: number): Mask => {
  const bits = new Uint8Array(W * H);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) bits[y * W + x] = 1;
  return { width: W, height: H, bits };
};
// A sailor sitting side-on, as in a quick sketch: SAM sees one leg, no boots and no trousers.
const found: Record<string, Mask[]> = {
  person: [box(40, 20, 80, 230)],
  head: [box(48, 20, 72, 50)],
  leg: [box(52, 140, 68, 230)],
  arm: [box(62, 60, 76, 130)],
};
vi.mock('../src/meta/sam.ts', () => ({
  samFind: vi.fn(async (_memo: unknown, { prompt }: { prompt: string }) => (found[prompt] ?? []).map((mask) => ({ mask }))),
}));
const { rigFigure } = await import('../src/scene/rig.ts');

test('a figure with only one leg showing still rigs, its far leg walking behind as a twin', async () => {
  const painting = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 200, g: 180, b: 40, alpha: 1 } } }).png().toBuffer();
  const { rig, issues } = await rigFigure({} as never, 'sailor', painting);
  expect(issues).toContain('one leg showing: the far leg walks behind it as its twin');
  expect(rig.leg.far.ankle[1]).toBeGreaterThan(rig.leg.far.knee[1]);
});
