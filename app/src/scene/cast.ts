import { STYLE_REFERENCE_PROMPT } from '../world/style-reference.ts';
import { drawers } from '../world/drawings.ts';
// The hero and every NPC as one painted figure each: Muse paints them alone on a plain ground, SAM cuts them out.
import sharp from 'sharp';
import type { Mask } from '../image/mask.ts';
import { maskBox, union } from '../image/raster.ts';
import { bodyShare, groundGaps, heldMask, heldThings } from './held.ts';
import { companions, silhouette } from './warp.ts';
import type { Memo } from '../meta/memo.ts';
import { museEdit, musePaint } from '../meta/muse.ts';
import { askSparkJson } from '../meta/spark.ts';
import { samFind } from '../meta/sam.ts';
import type { World } from '../world/schema.ts';
import { restyleFigurePrompt } from './restyle.ts';

export const HERO_PX = 600;

/** `holds`: what they hold, as SAM phrases, when the person named it (cast/fixes.json); else read from `looks`. */
export type Who = { key: string; looks: string; holds?: string[] };

export function figurePrompt(world: World, who: Who): string {
  return `A single full-body character for a 2D point-and-click adventure game, standing in a relaxed walking-ready pose, seen from the side in three-quarter view, facing to the right. The whole figure is visible from the top of the head down to both feet, centred, about two thirds of the image tall.

Character: ${who.looks}
Style: ${world.style}

Plain flat light grey background, no floor, no shadow, no other people, no props around, no text.`;
}

/** The biggest instance SAM finds of the hero, as an RGBA PNG cropped to the figure and HERO_PX tall. */
export async function cutHero(painting: Buffer, mask: Mask, held?: Mask): Promise<Buffer> {
  return (await cutOut(painting, mask, held)).figure;
}

/**
 * The cut-out, and the share of its height the body takes (`share`, 1 unless something held stands above the head):
 * `held` (scene/held.ts) is what SAM found of the things the description has in their hands, kept whatever its size.
 */
export async function cutOut(painting: Buffer, mask: Mask, held?: Mask): Promise<{ figure: Buffer; share: number }> {
  if (!maskBox(mask)) throw new Error('figure: the mask is empty');
  const { data, info } = await sharp(painting).resize(mask.width, mask.height, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  // SAM's person leaves out what they hold (a lantern, a net of fish) and leaves holes where it hangs over them.
  // ... and what floats beside them as part of who they are (a heart, the bubble they are in).
  const body = held ? union(mask, held) : mask;
  const whole = companions(data, silhouette(data, body));
  // Held up in both hands, the thing closes a window of plain ground with the arms and head: it stays see-through.
  if (held) for (const gap of groundGaps(data, whole, body)) gap.bits.forEach((b, i) => b && (whole.bits[i] = 0));
  for (let i = 0; i < whole.bits.length; i++) if (!whole.bits[i]) data[i * info.channels + 3] = 0;
  const [x0, y0, x1, y1] = maskBox(whole)!;
  const figure = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
    .resize({ height: HERO_PX })
    .png()
    .toBuffer();
  return { figure, share: bodyShare(mask, whole) };
}

/** For a photo of a real person standing whole in frame: same person, same pose and outline, so live footage can dissolve into the figure. */
export function photoPrompt(world: World): string {
  return `Repaint this photo of a person as a character of a 2D point-and-click adventure game. Keep the same person, face, hair, clothes, body proportions and exact pose, at the same place and size in the frame, so the outline matches the photo. Show the whole figure from head to feet.

Style: ${world.style}

Plain flat light grey background, no floor, no shadow, no other people, no text.`;
}

/**
 * For a photo of a person sitting, lying or cut off by the frame: the same person, standing. Their pose is not
 * theirs to keep: a hero painted sitting against a headboard walks as a sitting cut-out, and the 3D model is
 * built from that painting, headboard and all.
 */
export function photoStandPrompt(world: World, who: Who): string {
  return `Paint the person in this photo as a single full-body character for a 2D point-and-click adventure game: the same person, so anyone who knows them sees it at once (same face, hair, beard, build and clothes), but standing upright on both feet in a relaxed walking-ready pose, seen from the side in three-quarter view, facing to the right. In the photo they may be sitting, lying or cut off by the frame; here the whole figure is visible from the top of the head down to both feet, centred, about two thirds of the image tall. What the photo does not show (legs, trousers, shoes) is as described: ${who.looks}

Style: ${world.style}

Nothing they sat or lay on: no bed, headboard, pillow, chair or blanket. Plain flat light grey background, no floor, no shadow, no other people, no props around, no text.`;
}

/** For a drawing (a child's, or an artist's sketch): the character as drawn, made whole enough to walk. */
export function drawingPrompt(world: World, who: Who): string {
  const drawn = drawers(world);
  return `This is ${drawn.one} on paper. Paint the character in it as a single full-body character for a 2D point-and-click adventure game, so ${drawn.who} knows it at once: the same colours, the same clothes and features, the same shapes and proportions (a big head stays big), only cleaner and whole: every part coloured in solidly, with clear outlines and no white paper showing through, a finished character, not a sketch. Standing in a relaxed walking-ready pose, seen from the side in three-quarter view, facing to the right, the whole figure visible from the top of the head down to both feet (or paws), centred, about two thirds of the image tall.

Character: ${who.looks}
Style: ${world.style}

Plain flat light grey background, no paper, no table, no written name, no floor, no shadow, no other characters, no text.`;
}

/**
 * `from` is a photo of a real person (`standing`: whole and on their feet in it, so the pose is kept), or a child's
 * drawing of the character; `restyle` is the character as painted before in another style (`was`), repainted in the
 * world's style with the same face, clothes and pose. `upright` (a person on two legs, cast/figures.json): a figure
 * that comes out sitting, lying or cut off is painted once more, as a seated painting makes a seated walker and a
 * 3D model with the chair grown into it.
 */
export async function paintFigure(memo: Memo, world: World, who: Who, take = 0, from?: { photo?: Buffer; standing?: boolean; drawing?: Buffer; concept?: Buffer; styleReference?: Buffer; restyle?: { painting: Buffer; was: string } }, upright = false): Promise<{ painting: Buffer; figure: Buffer; share: number; holds: string[] }> {
  const edit = (args: Parameters<typeof museEdit>[1]) => museEdit(memo, from?.styleReference ? {
    ...args, prompt: args.prompt.replace('The LAST image is the creator-approved', 'The second-to-last image is the creator-approved') + '\nThe LAST image: ' + STYLE_REFERENCE_PROMPT,
    images: [...args.images, from.styleReference],
  } : args);
  let fallback: { painting: Buffer; figure: Buffer; share: number; holds: string[]; why: string } | undefined;
  const holds = await heldThings(memo, who);
  // A take SAM finds no one in (a drawing painted back as loose scribble) is painted once more before giving up.
  for (const t of [take, take + 1]) {
    const painting = from?.restyle
      ? await edit({ label: `figure:${who.key}:restyle`, prompt: restyleFigurePrompt(who.looks, from.restyle.was, world.style, !!from.drawing), images: [from.restyle.painting, ...(from.drawing ? [from.drawing] : [])], take: t })
      : from?.concept
      ? await edit({ label: `figure:${who.key}:approved`, prompt: (from.photo ? from.standing ? photoPrompt(world) : photoStandPrompt(world, who) : from.drawing ? drawingPrompt(world, who) : figurePrompt(world, who)) + '\nThe LAST image is the creator-approved character concept. Keep that identity: face, silhouette, proportions, clothing, markings and colours. Any earlier image is the original source drawing or photo: keep the person or drawn character recognizable. Adapt pose and background only as instructed above. The current written style and any explicit appearance edits take precedence over the old concept.', images: [...(from.photo ? [from.photo] : from.drawing ? [from.drawing] : []), from.concept], take: t })
      : from?.photo
      ? from.standing
        ? await edit({ label: `figure:${who.key}:photo`, prompt: photoPrompt(world), images: [await sharp(from.photo).rotate().png().toBuffer()], take: t })
        : await edit({ label: `figure:${who.key}:photo-stand`, prompt: photoStandPrompt(world, who), images: [await sharp(from.photo).rotate().png().toBuffer()], take: t })
      : from?.drawing
        ? await edit({ label: `figure:${who.key}:drawing`, prompt: drawingPrompt(world, who), images: [from.drawing], take: t })
        : (from?.styleReference ? await edit({ label: `figure:${who.key}`, prompt: figurePrompt(world, who), images: [], take: t }) : await musePaint(memo, { label: `figure:${who.key}`, prompt: figurePrompt(world, who), take: t }));
    const png = await sharp(painting).png().toBuffer();
    // Not every character is a person (a flock of pigeons, a cat): SAM is asked by their own description next.
    const biggest = await findFigure(memo, who, png);
    if (!biggest) continue;
    const made = { painting: png, ...(await cutOut(png, biggest.mask, await heldMask(memo, who.key, png, biggest.mask, holds))), holds };
    const why = (await boxed(made.figure)) ?? (upright ? await notStanding(memo, who.key, made.figure, t) : undefined);
    if (!why) return made;
    console.log(`  ${who.key} take ${t}: the figure is not standing whole (${why}); painting it once more`);
    fallback ??= { ...made, why };
  }
  if (fallback) {
    console.log(`  ${who.key}: kept a figure that is not standing whole (${fallback.why}); try another take (cast_redo anotherTake)`);
    return { painting: fallback.painting, figure: fallback.figure, share: fallback.share, holds };
  }
  throw new Error(`${who.key}: SAM found no one in the painting, two takes; try another take (cast_redo anotherTake)`);
}

/** The biggest one SAM finds of the character: as a person, else by its own description (a flock of pigeons, a cat), else as an animal. */
export async function findFigure(memo: Memo, who: Who, png: Buffer) {
  for (const prompt of ['person', who.looks.split(/[,.;]/)[0].trim().split(/\s+/).slice(0, 6).join(' '), 'animal']) {
    const found = await samFind(memo, { label: `figure:${who.key}`, image: png, prompt });
    if (found.length) return found.reduce((a, b) => (area(b.mask) > area(a.mask) ? b : a));
  }
  return undefined;
}

/**
 * Why a cut-out of a person on two legs is not one standing whole, or undefined when it is. A standing figure is
 * about twice as tall as wide (robots and big-headed drawn children down to about 1.4), so only a squatter one is
 * looked at by Spark: sitting with knees up comes out about as wide as tall.
 */
export async function notStanding(memo: Memo, key: string, figure: Buffer, take = 0): Promise<string | undefined> {
  const { width = 1, height = 1 } = await sharp(figure).metadata();
  if (height / width >= 1.6) return undefined;
  const flat = await sharp(figure).flatten({ background: '#cccccc' }).png().toBuffer();
  const a = await askSparkJson<{ standing?: unknown; why?: unknown }>(memo, {
    label: `figure-standing:${key}#${take}`, images: [flat],
    prompt: 'This is a character cut out for a 2D adventure game, where it has to walk. Is it standing upright on its own feet, with the whole body from head to feet shown, and nothing it sits or leans on? Sitting, lying, kneeling, crouching, or legs or feet cut off is no. A character that has no legs by nature (a ghost, a blob) is yes.\n\nReply with JSON only: {"standing": true or false, "why": "a few words"}',
  });
  return a.standing === false ? String(a.why ?? 'not standing') || 'not standing' : undefined;
}

const area = (m: Mask) => m.bits.reduce((s, b) => s + b, 0);

/**
 * Why a cut-out is a box and not a figure, or undefined: one that fills nearly all of its box kept the scene it
 * was painted standing in (a framed picture of stormy sea), and the game would draw that patch around them.
 */
export async function boxed(figure: Buffer): Promise<string | undefined> {
  const { data, info } = await sharp(figure).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  let solid = 0;
  for (let i = 0; i < info.width * info.height; i++) if (data[i] > 128) solid++;
  return solid > 0.85 * info.width * info.height ? 'cut out with the scene behind them, a box' : undefined;
}

/** A grown-up's height, the scale's unit (PERSON_M in src/scene/scale.ts). */
export const PERSON_M = 1.62;

/** How a character stands: metres tall, and whether upright on two legs like a person (a cat is not). */
export type Body = { height: number; upright: boolean };

/**
 * How tall each character stands, in metres (a cat about 0.3, a child about 1.1, a grown-up 1.62), so the
 * runtime draws an animal or a child at its own size, and whether it walks upright like a person: only those
 * get a walking rig, a 3D model and sprite sheets, the rest stay their painted figure. One Spark call for the cast.
 */
export async function castBodies(memo: Memo, world: World, cast: Who[]): Promise<Record<string, Body>> {
  if (!cast.length) return {};
  const prompt = `These are the characters of a 2D adventure game (${world.pitch}):
${cast.map((w) => `- ${w.key}: ${w.looks}`).join('\n')}
For each one: how tall does it stand, in metres, from the ground to the top of the head (for an animal on four legs, to the top of its head as it stands)? An ordinary grown-up is ${PERSON_M}. And does it stand and walk upright on two legs like a person (a person, a robot, a talking bear in a coat: yes; a cat, a dog, a horse, a bird, a fish: no)?
Reply with JSON only: {${cast.map((w) => `"${w.key}": {"m": <metres>, "upright": true or false}`).join(', ')}}`;
  const a = await askSparkJson<Record<string, { m?: unknown; upright?: unknown }>>(memo, { label: 'cast-bodies', prompt });
  return Object.fromEntries(cast.flatMap((w) => {
    const m = Number(a[w.key]?.m);
    return Number.isFinite(m) && m > 0 ? [[w.key, { height: Math.round(Math.min(3, Math.max(0.08, m)) * 100) / 100, upright: a[w.key]?.upright !== false }]] : [];
  }));
}

/** cast/figures.json (diorama cast): each character's body; absent, everyone is an upright grown-up. */
export function readBodies(files: { path(...p: string[]): string; readJson(p: string): unknown }, exists: (p: string) => boolean): Record<string, Body> {
  const at = files.path('cast', 'figures.json');
  return exists(at) ? (files.readJson(at) as Record<string, Body>) : {};
}
