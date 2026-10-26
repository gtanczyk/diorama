// Muse paints the hero from four sides, standing still: the front view is what TRELLIS turns into a
// model, and all four are projected back onto it, so the walking model looks painted from every side.
import { museEdit } from '../meta/muse.ts';
import type { Memo } from '../meta/memo.ts';
import type { ViewName } from './fit.ts';

const SIZE = '1024x1024';
const STAND = 'standing still in a relaxed A-pose: arms hanging slightly away from the body with a clear gap between arms and body, legs straight and slightly apart, feet flat';
const SAME_HEAD = 'Whatever is on the head (hood up or down, hat, hair) is exactly as in the front picture, from this side too.';
const PLAIN = 'Full body from head to feet, centred, nothing cropped. Plain flat light grey background, soft even light, no shadow on the ground, no other objects.';

/** Front from the cast painting; back from the front; the profiles from front and back, so the hood or hat stays the same. */
export async function paintViews(memo: Memo, key: string, looks: string, painting: Buffer, take = 0): Promise<Record<ViewName, Buffer>> {
  const front = await museEdit(memo, {
    label: `${key}-view-front`, size: SIZE, take, images: [painting],
    prompt: `The same character as in the picture (${looks}), same clothes, colours and painted style, now seen straight from the front, ${STAND}, face looking at the viewer. ${PLAIN}`,
  });
  const back = await museEdit(memo, {
    label: `${key}-view-back`, size: SIZE, take, images: [front],
    prompt: `The same character as in the picture (${looks}), same clothes, colours, patches and painted style, in exactly the same pose, seen straight from behind: we see the back of the head, the back of the clothes and the heels; the face is not visible. ${SAME_HEAD} Same size and position in the frame as the picture. ${PLAIN}`,
  });
  const side = (facing: 'left' | 'right') => museEdit(memo, {
    label: `${key}-view-${facing}`, size: SIZE, take, images: [front, back],
    prompt: `The same character as in both pictures (front and back views), same clothes, colours, patches and painted style, now seen exactly from the side in profile, facing to the ${facing} of the picture (${looks}). ${SAME_HEAD} Standing in the same relaxed pose: arms hanging straight down beside the body, legs straight and slightly apart. Same size and position in the frame as the pictures. ${PLAIN}`,
  });
  const [left, right] = await Promise.all([side('left'), side('right')]);
  return { front, back, left, right };
}
