import sharp from 'sharp';
import { expect, test } from 'vitest';
import { emptyMask } from '../src/image/mask.ts';
import { cutIcon, ICON_PX, itemSources } from '../src/scene/icons.ts';
import { Story } from '../src/story/schema.ts';

test('an item comes from the thing the hero takes it from, or is handed over', () => {
  const story = Story.parse({
    intro: 'Hi.',
    items: [{ key: 'boat', name: 'paper boat' }, { key: 'ticket', name: 'tram ticket' }],
    interactions: [
      { place: 'steps', thing: 'paper-boat', verb: 'take', say: 'Got it.', do: [{ give: 'boat' }], once: true },
      { place: 'kiosk', thing: 'basia', verb: 'use', with: 'boat', say: 'Thanks.', do: [{ take: 'boat' }, { give: 'ticket' }] },
    ],
    endings: [{ key: 'end', title: 'End', text: 'The end.' }],
  });
  expect(itemSources(story)).toEqual({ boat: { place: 'steps', thing: 'paper-boat' }, ticket: null });
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
