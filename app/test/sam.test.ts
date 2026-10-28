import { expect, test } from 'vitest';
import { maskArea } from '../src/image/mask.ts';
import { readSamOutput } from '../src/meta/sam.ts';

// Two instances on a 320x334 frame, taken from the @meta-sam/parser README.
const OUTPUT =
  '<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|>' +
  "<|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>" +
  ',1<|box;x1=155;y1=228;x2=202;y2=254;w=320;h=334|>' +
  '<|mask;x=0;y=0;data=27,48,~!!!!J!0c[q=Pj_zs=*4C4(/./x#:/`S_GnD`=o3?X{emCgO$y@|>\n';

test('each instance becomes a full-size mask inside its box', async () => {
  const found = await readSamOutput(OUTPUT, 320, 334);
  expect(found.map((f) => f.id)).toEqual(['0', '1']);
  for (const { mask, box } of found) {
    expect(mask.width * mask.height).toBe(320 * 334);
    expect(maskArea(mask)).toBeGreaterThan(0);
    mask.bits.forEach((b, i) => {
      if (!b) return;
      const x = i % 320, y = Math.floor(i / 320);
      expect(x >= box.left && x < box.right && y >= box.top && y < box.bottom).toBe(true);
    });
  }
});

test('no output means nothing found', async () => {
  expect(await readSamOutput('', 8, 8)).toEqual([]);
});
