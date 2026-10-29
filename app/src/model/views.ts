// Muse paints the hero from four sides, standing still: the front view is what TRELLIS turns into a
// model, and all four are projected back onto it, so the walking model looks painted from every side.
import { museEdit } from '../meta/muse.ts';
import type { Memo } from '../meta/memo.ts';
import type { ViewName } from './fit.ts';

const SIZE = '1024x1024';
/** Each view as it lands, so Studio shows them one by one while the rest are painted. */
type Landed = (name: ViewName, png: Buffer) => void;
const STAND = 'standing still in a relaxed A-pose: arms hanging slightly away from the body with a clear gap between arms and body, legs straight and slightly apart, feet flat';
// The arms in every view where the front has them: TRELLIS builds one body from all four, and each view is
// projected back onto it, so a hand in a pocket in one view is painted on the hip as a second pair of hands.
// Looks often say "hand in pocket"; this pose wins over it.
const HANDS = 'Both hands empty and fully visible, hanging beside the thighs: not in pockets, not on the hips, not holding anything, not in front of the body.';
const SAME_HEAD = 'Whatever is on the head (hood up or down, hat, hair) is exactly as in the front picture, from this side too.';
// Looks written from a photo may still say where the person sat or lay ("against a headboard"): a profile then
// paints the headboard behind them, and TRELLIS grows it into the body as a slab around the model.
const PLAIN = 'Full body from head to feet, centred, nothing cropped. Standing free: nothing behind or beside them, no bed, headboard, chair, wall or pillow, whatever the description says about where they were. Plain flat light grey background, soft even light, no shadow on the ground, no other objects.';

/** Front from the cast painting; back from the front; the profiles from front and back, so the hood or hat stays the same.
 * A creature (not a person on two legs: a round eye, a frog, a living teapot) is painted as it is, with no A-pose and no hands. */
export async function paintViews(memo: Memo, key: string, looks: string, painting: Buffer, take = 0, creature = false, onView?: Landed): Promise<Record<ViewName, Buffer>> {
  if (creature) return paintCreatureViews(memo, key, looks, painting, take, onView);
  const front = await museEdit(memo, {
    label: `${key}-view-front`, size: SIZE, take, images: [painting],
    prompt: `The same character as in the picture (${looks}), same clothes, colours and painted style, now seen straight from the front, ${STAND}, face looking at the viewer. ${HANDS} ${PLAIN}`,
  });
  onView?.('front', front);
  const back = await museEdit(memo, {
    label: `${key}-view-back`, size: SIZE, take, images: [front],
    prompt: `The same character as in the picture (${looks}), same clothes, colours, patches and painted style, in exactly the same pose, seen straight from behind: we see the back of the head, the back of the clothes and the heels; the face is not visible. ${HANDS} ${SAME_HEAD} Same size and position in the frame as the picture. ${PLAIN}`,
  });
  onView?.('back', back);
  const side = (facing: 'left' | 'right') => museEdit(memo, {
    label: `${key}-view-${facing}`, size: SIZE, take, images: [front, back],
    prompt: `The same character as in both pictures (front and back views), same clothes, colours, patches and painted style, now seen exactly from the side in profile, facing to the ${facing} of the picture (${looks}). ${SAME_HEAD} Standing in the same relaxed pose: arms hanging straight down beside the body, legs straight and slightly apart. ${HANDS} Same size and position in the frame as the pictures. ${PLAIN}`,
  }).then((png) => (onView?.(facing, png), png));
  const [left, right] = await Promise.all([side('left'), side('right')]);
  return { front, back, left, right };
}

// A creature keeps its own shape: whatever feet, fins or nothing it has, as in the painting. The whole body
// in every view, the same size and position, so TRELLIS builds one body from all four.
const REST = 'resting in its natural pose, exactly the body shape, proportions, feet, eyes and markings of the picture, nothing added (no arms, no legs, no clothes it does not have)';

async function paintCreatureViews(memo: Memo, key: string, looks: string, painting: Buffer, take: number, onView?: Landed): Promise<Record<ViewName, Buffer>> {
  const front = await museEdit(memo, {
    label: `${key}-view-front`, size: SIZE, take, images: [painting],
    prompt: `The same creature as in the picture (${looks}), same colours and painted style, now seen straight from the front, ${REST}, its face (or its front) to the viewer. The whole creature, centred, filling about two thirds of the frame. ${PLAIN}`,
  });
  onView?.('front', front);
  const back = await museEdit(memo, {
    label: `${key}-view-back`, size: SIZE, take, images: [front],
    prompt: `The same creature as in the picture (${looks}), same colours and painted style, in exactly the same pose, seen straight from behind: we see its back, its face is not visible. Same size and position in the frame as the picture. ${PLAIN}`,
  });
  onView?.('back', back);
  const side = (facing: 'left' | 'right') => museEdit(memo, {
    label: `${key}-view-${facing}`, size: SIZE, take, images: [front, back],
    prompt: `The same creature as in both pictures (front and back views), same colours and painted style, now seen exactly from the side in profile, facing to the ${facing} of the picture (${looks}), ${REST}. Same size and position in the frame as the pictures. ${PLAIN}`,
  }).then((png) => (onView?.(facing, png), png));
  const [left, right] = await Promise.all([side('left'), side('right')]);
  return { front, back, left, right };
}
