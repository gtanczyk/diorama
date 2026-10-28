import sharp from 'sharp';
import { expect, test } from 'vitest';
import { emptyMask, maskArea } from '../src/image/mask.ts';
import { cutIcon, ICON_PX, itemSources, offGround, peelGround } from '../src/scene/icons.ts';
import { removableThings } from '../src/story/engine.ts';
import { Story } from '../src/story/schema.ts';

test('an item comes from the thing the hero takes it from, or is handed over', () => {
  const story = Story.parse({
    intro: 'Hi.',
    items: [{ key: 'paper-boat', name: 'paper boat' }, { key: 'ticket', name: 'tram ticket' }, { key: 'fish', name: 'dried fish' }],
    interactions: [
      { place: 'steps', thing: 'paper-boat', verb: 'take', say: 'Got it.', do: [{ give: 'paper-boat' }], once: true },
      { place: 'kiosk', thing: 'basia', verb: 'use', with: 'paper-boat', say: 'Thanks.', do: [{ take: 'paper-boat' }, { give: 'ticket' }] },
      // Found in the stalls: the stalls stay in the painting, and the fish is painted.
      { place: 'steps', thing: 'stalls', verb: 'take', say: 'A fish.', do: [{ give: 'fish' }], once: true },
    ],
    endings: [{ key: 'end', title: 'End', text: 'The end.' }],
  });
  expect(itemSources(story)).toEqual({ 'paper-boat': { place: 'steps', thing: 'paper-boat' }, ticket: null, fish: null });
  expect(removableThings(story)).toEqual([{ place: 'steps', thing: 'paper-boat' }]);
});

test('a cut-out icon is square, transparent around the thing, and the thing fills it', async () => {
  const mask = emptyMask(200, 100);
  for (let y = 40; y < 60; y++) for (let x = 20; x < 80; x++) mask.bits[y * 200 + x] = 1;
  const painting = await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();
  const { data, info } = await sharp(await cutIcon(painting, mask)).raw().toBuffer({ resolveWithObject: true });
  expect([info.width, info.height]).toEqual([ICON_PX, ICON_PX]);
  const alpha = (x: number, y: number) => data[(y * info.width + x) * 4 + 3];
  expect(alpha(0, 0)).toBe(0);
  expect(alpha(ICON_PX / 2, ICON_PX / 2)).toBe(255);
  // 60x20 fits 168 wide: the thing spans most of the icon's width.
  expect(alpha(30, ICON_PX / 2)).toBeGreaterThan(200);
});

test("a painted item on a shaded wash is cut without the wash, and a band of ground is peeled off", async () => {
  // 200x200: pale ground, a darker blue wash (a disc of r 60), an orange item (a disc of r 30) on it.
  const W = 200;
  const px = Buffer.alloc(W * W * 3);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const d = Math.hypot(x - 100, y - 100);
    const c = d < 30 ? [200, 120, 40] : d < 60 ? [150, 165, 175] : [185, 197, 193];
    px.set(c, (y * W + x) * 3);
  }
  const picture = await sharp(px, { raw: { width: W, height: W, channels: 3 } }).png().toBuffer();
  const mask = (await offGround(picture))!;
  const area = maskArea(mask);
  expect(area).toBeGreaterThan(Math.PI * 28 ** 2);
  expect(area).toBeLessThan(Math.PI * 33 ** 2);
  // SAM's mask took a band of the ground around the item: peeling brings it back to the item.
  const wide = emptyMask(W, W);
  for (let i = 0; i < W * W; i++) if (Math.hypot((i % W) - 100, Math.floor(i / W) - 100) < 72) wide.bits[i] = 1;
  const peeled = maskArea(await peelGround(picture, wide));
  expect(peeled).toBeLessThan(Math.PI * 64 ** 2);
  expect(peeled).toBeGreaterThan(Math.PI * 58 ** 2);
});
