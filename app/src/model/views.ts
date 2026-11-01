// Muse paints the hero from four sides, standing still: the front view is what TRELLIS turns into a
// model, and all four are projected back onto it, so the walking model looks painted from every side.
import sharp from 'sharp';
import { museEdit } from '../meta/muse.ts';
import type { Memo } from '../meta/memo.ts';
import type { ViewName } from './fit.ts';
import { askSparkJson } from '../meta/spark.ts';
import { refusedByFilter } from '../scene/words.ts';

const SIZE = '1024x1024';
/** Each view as it lands, so Studio shows them one by one while the rest are painted. */
type Landed = (name: ViewName, png: Buffer) => void;
const STAND = 'standing still in a clear rigging A-pose: both straight arms extended diagonally outwards 35 degrees from vertical, elbows straight, hands at least one hand-width away from the thighs, a wide uninterrupted background gap between each arm and the torso and hips, legs straight and shoulder-width apart, feet flat';
// The arms in every view where the front has them: TRELLIS builds one body from all four, and each view is
// projected back onto it, so a hand in a pocket in one view is painted on the hip as a second pair of hands.
// Looks often say "hand in pocket"; this pose wins over it.
// Empty hands make Muse put down what the painting had in them: a suitcase standing at the feet in one view
// becomes a slab TRELLIS fuses to a boot, and it swings with the leg in every sprite. So it is left out, not put down.
// A held flag left "out of the hands" ends up waving behind the figure; TRELLIS fuses it to the back as a
// mangled sheet and the auto-rig skins it to the spine, so a held pole or flag is named and banned outright.
const HANDS = 'Both hands empty and fully visible, well separated from the thighs, never touching clothing: not in pockets, not on the hips, not holding anything, not in front of the body. Whatever the description has in their hands (a suitcase, a basket, a tool) is left out of the picture altogether, never put down on the ground beside them. ' +
  'A flag, banner, pole, staff, spear, broom, umbrella, sign or lantern they held is left out too: not behind them, not over the shoulder, not on the back, nowhere in the picture.';
const SAME_HEAD = 'Whatever is on the head (hood up or down, hat, hair) is exactly as in the front picture, from this side too.';
// Looks written from a photo may still say where the person sat or lay ("against a headboard"): a profile then
// paints the headboard behind them, and TRELLIS grows it into the body as a slab around the model.
const PLAIN = 'Full body from head to feet, centred, nothing cropped. Standing free: nothing behind or beside them, no bed, headboard, chair, wall or pillow, whatever the description says about where they were. Plain flat light grey background, soft even light, no shadow on the ground, no other objects: nothing standing or lying on the ground, nothing at their feet.';

/** Where a carried thing sits on the body, from the character's own point of view. */
export type Spot = 'front' | 'back' | 'left' | 'right';
/** Something the character wears or carries that is not plain clothing: a bag, a satchel, a lantern, a sword. */
export type Carried = { name: string; at: Spot; strap?: string };

/**
 * Where a thing at `at` (the character's own front, back, left or right) shows in a view. Views are straight on:
 * front sees the character's left at the picture's right; the "left" profile faces the picture's left and shows
 * the character's left side (src/model/fit.ts axes).
 */
export function spotIn(view: ViewName, at: Spot): string {
  const table: Record<ViewName, Record<Spot, string>> = {
    front: { front: 'on the front of the body, in the middle', back: 'behind the body, hidden (only a strap may show)', left: 'at the right edge of the figure in the picture (the character\'s left side)', right: 'at the left edge of the figure in the picture (the character\'s right side)' },
    back: { front: 'in front of the body, hidden (only a strap may show over the shoulder or round the side)', back: 'on the back, in the middle, fully visible', left: 'at the LEFT edge of the figure in the picture (the character\'s left side, seen from behind)', right: 'at the RIGHT edge of the figure in the picture (the character\'s right side, seen from behind)' },
    left: { front: 'in front of the body, at the LEFT edge of the figure, where the character faces', back: 'on the back, at the RIGHT edge of the figure, behind the character', left: 'on the near side, fully visible against the body', right: 'on the far side, hidden behind the body (only a strap may show)' },
    right: { front: 'in front of the body, at the RIGHT edge of the figure, where the character faces', back: 'on the back, at the LEFT edge of the figure, behind the character', left: 'on the far side, hidden behind the body (only a strap may show)', right: 'on the near side, fully visible against the body' },
  };
  return table[view][at];
}

/** What the character carries and where, read once off the front view: the other views are told exactly where each thing goes. */
export async function readCarried(memo: Memo, key: string, front: Buffer): Promise<Carried[]> {
  const a = await askSparkJson<{ items?: { name?: unknown; at?: unknown; strap?: unknown }[] }>(memo, {
    label: `views-carried:${key}`, images: [front],
    prompt: 'This character is seen straight from the front (their left hand is on the right of the picture). List what they wear on the body that is not plain clothing and that could end up on the wrong side in a drawing from another side: bags, satchels, backpacks, pouches, a sword in a belt, a quiver, a scarf end, a badge. '
      + 'Only things fastened to the body (a strap, a belt, a hook, worn): never something held in a hand or held up, and never a flag, banner, pole, staff, umbrella or lantern, even when one shows behind them (those do not belong in this picture). '
      + 'For each: where its main part sits on the body from the character\'s own point of view, one of "front", "back", "left", "right" (a bag hanging at their left hip is "left", one on their belly is "front"), and the strap if any (e.g. "over the right shoulder, across the chest"). '
      + 'Reply with JSON only: {"items": [{"name": "brown leather satchel", "at": "front", "strap": "over the right shoulder, across the chest"}]} or {"items": []}.',
  });
  const spots = ['front', 'back', 'left', 'right'];
  return (a.items ?? []).flatMap((i) => (typeof i.name === 'string' && spots.includes(String(i.at)) ? [{ name: i.name, at: i.at as Spot, ...(typeof i.strap === 'string' && i.strap && { strap: i.strap }) }] : []));
}

/** The sentence a view's prompt gets: each carried thing, where it shows in this view. */
export function carriedLine(view: ViewName, items: Carried[]): string {
  if (!items.length) return '';
  return `What they carry stays where it is on the body, it does not move round when we walk round them: ${items.map((i) => `the ${i.name}${i.strap ? ` (strap ${i.strap})` : ''} is ${spotIn(view, i.at)}`).join('; ')}.`;
}

/** A view at check size: where a bag hangs reads at 640 px; four full 1024 px views cost four times the tokens. */
const small = (png: Buffer) => sharp(png).resize(640, 640, { fit: 'inside' }).png().toBuffer();

/** The views that show a carried thing in the wrong place, or something on the ground at the feet, with why. */
export async function checkCarried(memo: Memo, key: string, views: Record<ViewName, Buffer>, items: Carried[], round = 0): Promise<Partial<Record<ViewName, string>>> {
  const names: ViewName[] = ['front', 'back', 'left', 'right'];
  const expect = items.length ? names.map((v, n) => `Picture ${n + 1} (${v} view): ${items.map((i) => `the ${i.name} should be ${spotIn(v, i.at)}`).join('; ')}.`).join('\n') : 'They carry nothing that is not plain clothing.';
  const a = await askSparkJson<Record<string, { ok?: unknown; why?: unknown }>>(memo, {
    label: `views-carried-check:${key}#${round}`, images: await Promise.all(names.map((v) => small(views[v]))),
    prompt: `Four pictures of one character, seen from the front, back, their left side (facing the picture's left) and their right side (facing the picture's right). Check only where the carried things are, and that nothing stands or lies on the ground; ignore everything else.\n${expect}\n\n`
      + 'A thing that shows on the wrong side of the body, on the front when it should be on the back (or the other way round), twice, or missing where it should be fully visible, is wrong. '
      + 'Anything standing or lying on the ground, at the feet or beside them (a suitcase, a bag, a box, a plank), or held in a hand, is wrong in every view, the front too; so is a flag, banner, pole, staff or umbrella anywhere in the picture, behind the figure or over the shoulder too. '
      + `Reply with JSON only: {${names.map((v) => `"${v}": {"ok": true or false, "why": "a few words"}`).join(', ')}}`,
  });
  return Object.fromEntries(names.flatMap((v) => (a[v]?.ok === false ? [[v, String(a[v]?.why ?? 'carried thing in the wrong place')]] : [])));
}

/** Rounds of repainting the views a carried thing went wrong in. */
const CARRIED_ROUNDS = 2;

/** Front from the cast painting; back from the front; the profiles from front and back, so the hood or hat stays the same.
 * What they carry (a satchel, a lantern) is read off the front and placed by name in every other view, then all four
 * are checked together and a view that put it on the wrong side, or put something down at the feet, is painted again.
 * A creature (not a person on two legs: a round eye, a frog, a living teapot) is painted as it is, with no A-pose and no hands. */
// The image safety filter refuses a prompt on single words (a long list of things to leave out reads as a list of
// weapons): the view is asked once more in calm words, with the looks left to the picture and the hands said plainly.
const HANDS_CALM = 'Both hands open and empty, well apart from the body, nothing held and nothing else in the picture.';
type EditReq = Parameters<typeof museEdit>[1];
const viewEdit = (memo: Memo, looks: string) => (req: EditReq) => museEdit(memo, req).catch((error: unknown) => {
  if (!refusedByFilter(error)) throw error;
  console.log(`  ${req.label}: the image safety filter refused the view; asking in calm words`);
  const prompt = req.prompt.split(HANDS).join(HANDS_CALM).split(` (${looks})`).join('');
  return museEdit(memo, { ...req, label: `${req.label}-calm`, prompt });
});

export async function paintViews(memo: Memo, key: string, looks: string, painting: Buffer, take = 0, creature = false, onView?: Landed, again = true): Promise<Record<ViewName, Buffer>> {
  if (creature) return paintCreatureViews(memo, key, looks, painting, take, onView);
  const edit = viewEdit(memo, looks);
  const front = await edit({
    label: `${key}-view-front`, size: SIZE, take, images: [painting],
    prompt: `The same character as in the picture (${looks}), same clothes, colours and painted style, now seen straight from the front, ${STAND}, face looking at the viewer. Anything they carry (a bag, a satchel) stays where it is on their body in the picture. ${HANDS} ${PLAIN}`,
  });
  onView?.('front', front);
  const items = await readCarried(memo, key, front);
  if (items.length) console.log(`  ${key}: carries ${items.map((i) => `${i.name} (${i.at})`).join(', ')}`);
  const paintBack = (t: number) => edit({
    label: `${key}-view-back`, size: SIZE, take: t, images: [front],
    prompt: `The same character as in the picture (${looks}), same clothes, colours, patches and painted style, in exactly the same pose, seen straight from behind: we see the back of the head, the back of the clothes and the heels; the face is not visible. Left and right swap when seen from behind. ${carriedLine('back', items)} ${HANDS} ${SAME_HEAD} Same size and position in the frame as the picture. ${PLAIN}`,
  });
  const views: Record<ViewName, Buffer> = { front, back: await paintBack(take), left: front, right: front };
  onView?.('back', views.back);
  const side = (facing: 'left' | 'right', t: number) => edit({
    label: `${key}-view-${facing}`, size: SIZE, take: t, images: [front, views.back],
    prompt: `The same character as in both pictures (front and back views), same clothes, colours, patches and painted style, now seen exactly from the side in profile, facing to the ${facing} of the picture, so we see their ${facing} side (${looks}). ${carriedLine(facing, items)} ${SAME_HEAD} Keep exactly the same rigging A-pose as the front and back: straight arms angled out sideways 35 degrees from vertical, hands clear of the thighs, legs straight and shoulder-width apart. Do not lower the arms against the hips for this profile. ${HANDS} Same size and position in the frame as the pictures. ${PLAIN}`,
  });
  [views.left, views.right] = await Promise.all((['left', 'right'] as const).map((f) => side(f, take).then((png) => (onView?.(f, png), png))));
  for (let round = 0; round < CARRIED_ROUNDS; round++) {
    const wrong = await checkCarried(memo, key, views, items, round);
    // The other three are painted from the front: a wrong front means all four again, once.
    if (wrong.front && again) {
      console.log(`  ${key}: front view: ${wrong.front}; painting all four again`);
      return paintViews(memo, key, looks, painting, take + 1, false, onView, false);
    }
    delete wrong.front;
    const redo = Object.keys(wrong) as ViewName[];
    if (!redo.length) break;
    console.log(`  ${key}: ${redo.map((v) => `${v} view: ${wrong[v]}`).join('; ')}; painting ${redo.length === 1 ? 'it' : 'them'} again`);
    const t = take + 1 + round;
    if (wrong.back) (views.back = await paintBack(t), onView?.('back', views.back));
    await Promise.all((['left', 'right'] as const).filter((f) => wrong[f]).map(async (f) => { views[f] = await side(f, t); onView?.(f, views[f]); }));
  }
  return views;
}

// A creature keeps its own shape: whatever feet, fins or nothing it has, as in the painting. The whole body
// in every view, the same size and position, so TRELLIS builds one body from all four.
const REST = 'resting in its natural pose, exactly the body shape, proportions, feet, eyes and markings of the picture, nothing added (no arms, no legs, no clothes it does not have)';

async function paintCreatureViews(memo: Memo, key: string, looks: string, painting: Buffer, take: number, onView?: Landed): Promise<Record<ViewName, Buffer>> {
  const edit = viewEdit(memo, looks);
  const front = await edit({
    label: `${key}-view-front`, size: SIZE, take, images: [painting],
    prompt: `The same creature as in the picture (${looks}), same colours and painted style, now seen straight from the front, ${REST}, its face (or its front) to the viewer. The whole creature, centred, filling about two thirds of the frame. ${PLAIN}`,
  });
  onView?.('front', front);
  const back = await edit({
    label: `${key}-view-back`, size: SIZE, take, images: [front],
    prompt: `The same creature as in the picture (${looks}), same colours and painted style, in exactly the same pose, seen straight from behind: we see its back, its face is not visible. Same size and position in the frame as the picture. ${PLAIN}`,
  });
  onView?.('back', back);
  const side = (facing: 'left' | 'right') => edit({
    label: `${key}-view-${facing}`, size: SIZE, take, images: [front, back],
    prompt: `The same creature as in both pictures (front and back views), same colours and painted style, now seen exactly from the side in profile, facing to the ${facing} of the picture (${looks}), ${REST}. Same size and position in the frame as the pictures. ${PLAIN}`,
  }).then((png) => (onView?.(facing, png), png));
  const [left, right] = await Promise.all([side('left'), side('right')]);
  return { front, back, left, right };
}
