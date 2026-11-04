// What a character holds or carries as part of who they are (a giant slice of toast over their head, a lantern, a
// net of fish): named from their description, found by SAM on its own and kept on the cut-out. SAM's "person" is
// only the body, and the plain-ground heuristics in warp.ts (silhouette, companions) drop anything bigger than the
// figure as the scene behind it, so a prop larger than its holder needs its own mask.
import sharp from 'sharp';
import { emptyMask, maskArea, type Mask } from '../image/mask.ts';
import { components, dilate, maskBox, subtract, union } from '../image/raster.ts';
import { fillHoles } from './warp.ts';
import type { Memo } from '../meta/memo.ts';
import { samFind } from '../meta/sam.ts';
import { askSparkJson } from '../meta/spark.ts';

/** Words that say the description has something in hand; without one no Spark call is made. */
const HOLDING = /\b(hold|holds|holding|held|carr(y|ies|ying|ied)|clutch\w*|grip\w*|grasp\w*|wield\w*|lift\w*|rais\w*|balanc\w*|hug\w*|cradl\w*|bear(s|ing)?|tow\w*|drag\w*|push\w*|pull\w*|swing\w*|brandish\w*|in (his|her|their|its|one|both) (hand|hands|arms|paws|claws|wings|beak|mouth))\b/i;

/**
 * The things the character holds, carries or lifts, as short phrases SAM can search ("slice of toast", "lantern").
 * `holds` (cast/fixes.json, set by the person) wins; otherwise one memoized Spark call on the description, and none
 * at all when it says nothing about holding. Clothing and what is worn is never in the list: SAM's person has it.
 */
export async function heldThings(memo: Memo, who: { key: string; looks: string; holds?: string[] }): Promise<string[]> {
  if (who.holds) return who.holds.map((h) => h.trim()).filter(Boolean);
  if (!HOLDING.test(who.looks)) return [];
  const a = await askSparkJson<{ held?: unknown }>(memo, {
    label: `figure-held:${who.key}`,
    prompt: `A character of a 2D adventure game is described like this:\n"${who.looks}"\n\nList the separate objects the character holds, carries, lifts or balances (in hands, arms, paws, beak or on the head as a load), as short concrete noun phrases of 1 to 4 words that an image segmentation model can search for, e.g. "slice of toast", "lantern", "fishing net". Never list clothing, a hat, shoes, a bag strap worn on the body, hair, body parts, or a face or pattern drawn on the object itself. If they hold nothing, the list is empty.\n\nReply with JSON only: {"held": ["..."]}`,
  });
  return Array.isArray(a.held) ? a.held.filter((h): h is string => typeof h === 'string' && !!h.trim()).map((h) => h.trim()).slice(0, 3) : [];
}

/**
 * Every instance SAM finds of the held things that touches the figure (or comes within a few percent of its height),
 * outside SAM's person, as one mask; undefined when there is none. One or two SAM calls per phrase, memoized with the
 * image; when SAM finds none of them, what stands out from the plain ground and touches the body (plainHeld).
 */
export async function heldMask(memo: Memo, key: string, image: Buffer, person: Mask, phrases: string[]): Promise<Mask | undefined> {
  const box = maskBox(person);
  if (!box || !phrases.length) return undefined;
  const near = dilate(person, Math.max(3, Math.round(0.04 * (box[3] - box[1]))));
  let out: Mask | undefined;
  for (const phrase of phrases) {
    // "slice of toast" may find nothing where "toast" does: the head noun is asked next.
    const head = /\bof\b/i.test(phrase) ? phrase.split(/\bof\b/i).pop()!.trim() : phrase.trim().split(/\s+/).pop()!;
    for (const prompt of [...new Set([phrase, head])]) {
      let hit = false;
      for (const found of await samFind(memo, { label: `figure:${key}:held`, image, prompt })) {
        const own = subtract(found.mask, person);
        if (maskArea(own) < 0.01 * maskArea(person)) continue;
        if (!own.bits.some((b, i) => b && near.bits[i])) continue;
        out = union(out ?? emptyMask(person.width, person.height), own);
        hit = true;
      }
      if (hit) break;
    }
  }
  if (out) return out;
  const { data } = await sharp(image).resize(person.width, person.height, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return plainHeld(data, person);
}

/**
 * Without SAM: the figure is painted alone on a plain ground, so what stands out from that ground and touches the
 * body (not the picture's edge) is what they hold. Used when the description says they hold something SAM did not find.
 */
export function plainHeld(rgba: Buffer, person: Mask, tolerance = 64): Mask | undefined {
  const { width: W, height: H } = person;
  const box = maskBox(person);
  if (!box) return undefined;
  const [, py0, , py1] = box;
  const ground = groundColour(rgba, W, H);
  const ink = emptyMask(W, H);
  for (let i = 0; i < W * H; i++) ink.bits[i] = !person.bits[i] && Math.hypot(rgba[i * 4] - ground[0], rgba[i * 4 + 1] - ground[1], rgba[i * 4 + 2] - ground[2]) > tolerance ? 1 : 0;
  // The outline drawn round a thing is ink too, so the thing and its outline join into one piece.
  const near = dilate(person, 3);
  let out: Mask | undefined;
  for (const c of components(fillHoles(ink))) {
    const b = maskBox(c)!;
    if (b[0] <= 1 || b[1] <= 1 || b[2] >= W - 1 || b[3] >= H - 1) continue;
    if (maskArea(c) < 0.05 * maskArea(person) || !c.bits.some((v, i) => v && near.bits[i])) continue;
    // A patch of floor or shadow at the feet is not held.
    if ((b[1] + b[3]) / 2 > py0 + 0.85 * (py1 - py0)) continue;
    out = union(out ?? emptyMask(W, H), subtract(c, person));
  }
  return out;
}

/** The patches of plain ground (the picture's border colour) inside `whole` that are no part of `body`, bigger than a speck. */
export function groundGaps(rgba: Buffer, whole: Mask, body: Mask, tolerance = 40): Mask[] {
  const { width: W, height: H } = whole;
  const ground = groundColour(rgba, W, H);
  const gap = emptyMask(W, H);
  for (let i = 0; i < W * H; i++) gap.bits[i] = whole.bits[i] && !body.bits[i] && Math.hypot(rgba[i * 4] - ground[0], rgba[i * 4 + 1] - ground[1], rgba[i * 4 + 2] - ground[2]) <= tolerance ? 1 : 0;
  return components(gap).filter((c) => maskArea(c) > 0.002 * maskArea(body));
}

const groundColour = (rgba: Buffer, W: number, H: number) => {
  const border: number[][] = [];
  for (let x = 0; x < W; x += 4) for (const y of [0, H - 1]) border.push([...rgba.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)]);
  for (let y = 0; y < H; y += 4) for (const x of [0, W - 1]) border.push([...rgba.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)]);
  return [0, 1, 2].map((c) => border.map((p) => p[c]).sort((a, b) => a - b)[border.length >> 1]);
};

/** The share of the cut-out's height the body takes, its feet at the bottom: a prop held over the head makes it less than 1. */
export function bodyShare(person: Mask, whole: Mask): number {
  const p = maskBox(person);
  const w = maskBox(whole);
  if (!p || !w) return 1;
  return Math.min(1, Math.round(((p[3] - p[1]) / Math.max(1, w[3] - w[1])) * 1000) / 1000);
}
