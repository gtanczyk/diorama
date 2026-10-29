import { expect, test } from 'vitest';
import { emptyMask, maskArea } from '../src/image/mask.ts';
import { dilate, maskBox, rectMask, union } from '../src/image/raster.ts';
import { seamOf } from '../src/scene/backdrop.ts';
import { reachesEdge, wholeBox, wholeThing } from '../src/scene/masks.ts';

const W = 1200, H = 896;
const none = emptyMask(W, H);
// A bucket, and the fish heads over its rim that SAM by name leaves out.
const bucket = rectMask(W, H, [500, 500, 700, 700]);
const fish = rectMask(W, H, [520, 440, 680, 502]);

test('the parts SAM by the whole box finds on the thing are joined to it', () => {
  const whole = wholeThing(bucket, union(bucket, fish), none);
  expect(whole.added).toBeGreaterThan(0.9 * maskArea(fish) - 400);
  expect(maskBox(whole.mask)).toEqual([500, 440, 700, 700]);
});

test('the box is refused when it found something else or took in the floor around it', () => {
  expect(wholeThing(bucket, rectMask(W, H, [800, 500, 900, 700]), none)).toMatchObject({ added: 0, why: expect.stringMatching(/something else/) });
  expect(wholeThing(bucket, rectMask(W, H, [300, 300, 1000, 760]), none)).toMatchObject({ added: 0, why: expect.stringMatching(/took in/) });
});

test('another thing is never taken, and parts not touching the thing are not its parts', () => {
  expect(wholeThing(bucket, union(bucket, fish), fish).added).toBe(0);
  expect(wholeThing(bucket, union(bucket, rectMask(W, H, [520, 300, 680, 400])), none).added).toBe(0);
});

test('the whole box reaches above the mask, and parts at its edge ask for a bigger one', () => {
  const box = wholeBox([500, 500, 700, 700], undefined);
  expect(box[1]).toBeLessThan(450);
  expect(box[3]).toBeLessThan(720);
  expect(reachesEdge([500, box[1] + 2, 700, 700], box)).toBe(true);
  expect(reachesEdge([500, 470, 700, 700], box)).toBe(false);
});

/** Cobbles: a fine checker that changes anyway, the kind of floor a removal continues. */
function cobbles(): Uint8Array {
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const v = ((i % W) >> 3) % 2 ^ (Math.floor(i / W) >> 3) % 2 ? 70 : 90;
    rgb.set([v, v + 10, v + 30], i * 3);
  }
  return rgb;
}
const paint = (rgb: Uint8Array, m: ReturnType<typeof rectMask>, c: [number, number, number]) => {
  for (let i = 0; i < W * H; i++) if (m.bits[i]) rgb.set(c, i * 3);
  return rgb;
};

test('the seam gate: a card cut short of its fish leaves them on the backdrop; a whole card does not', () => {
  const painting = paint(paint(cobbles(), bucket, [150, 150, 160]), fish, [220, 210, 190]);
  // Muse took out the bucket and its fish: cobbles everywhere.
  const edited = cobbles();
  const floorY = 670;
  const short = dilate(bucket, 14);
  const cutBackdrop = Uint8Array.from(painting);
  for (let i = 0; i < W * H; i++) if (short.bits[i]) cutBackdrop.set(edited.subarray(i * 3, i * 3 + 3), i * 3);
  const cut = seamOf({ painting, backdrop: cutBackdrop, edited }, W, H, short, { floorY });
  expect(cut.cut).toBe(true);
  expect(cut.box![1]).toBeLessThan(500);

  const full = dilate(union(bucket, fish), 14);
  const wholeBackdrop = Uint8Array.from(painting);
  for (let i = 0; i < W * H; i++) if (full.bits[i]) wholeBackdrop.set(edited.subarray(i * 3, i * 3 + 3), i * 3);
  expect(seamOf({ painting, backdrop: wholeBackdrop, edited }, W, H, full, { floorY }).cut).toBe(false);
});
