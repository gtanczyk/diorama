// A real photo as a place: crop it to the game frame, let Spark read the room into things,
// and let Muse repaint it in the world's style without moving anything.
import sharp from 'sharp';
import { z } from 'zod';
import type { Memo } from '../meta/memo.ts';
import { museEdit } from '../meta/muse.ts';
import { askSparkJson } from '../meta/spark.ts';
import { Place, World } from '../world/schema.ts';
import type { Brief } from './brief.ts';
import { FRAME } from './layout.ts';

/** Where the game frame sits in the original photo, so a film can line the real and painted frames up. */
export const PhotoCrop = z.object({
  source: z.object({ width: z.number(), height: z.number() }),
  crop: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  frame: z.object({ width: z.number(), height: z.number() }),
});
export type PhotoCrop = z.infer<typeof PhotoCrop>;

/** The largest centred crop with the frame's aspect, scaled to the frame. EXIF rotation is applied first. */
export async function framePhoto(photo: Buffer): Promise<{ image: Buffer; crop: PhotoCrop }> {
  const upright = await sharp(photo).rotate().toBuffer();
  const { width = 0, height = 0 } = await sharp(upright).metadata();
  const aspect = FRAME.width / FRAME.height;
  const w = Math.min(width, Math.round(height * aspect));
  const h = Math.min(height, Math.round(w / aspect));
  const crop = { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), width: w, height: h };
  const image = await sharp(upright).extract({ left: crop.x, top: crop.y, width: w, height: h })
    .resize(FRAME.width, FRAME.height, { fit: 'fill' }).png().toBuffer();
  return { image, crop: { source: { width, height }, crop, frame: { ...FRAME } } };
}

/** Spark reads the photo into a place: what it shows and the things in it, the way out as an exit. */
export async function describePhoto(memo: Memo, image: Buffer, idea: string): Promise<Place> {
  const prompt = `This photo of a real room becomes the first place of a 2D point-and-click adventure. The game idea:
"""
${idea}
"""

Describe the room as it is; invent nothing that is not in the photo, and leave out any person in it.
- key: a kebab-case name for the room
- shows: what the photo shows, front to back
- mood: the light and time of day in the photo, and the feeling it should have in the game
- things: 3 to 7 things big enough to click, each with role prop, item or exit; the door is an exit, one small loose object the hero could pick up is an item

Reply with JSON only:
{"key": "...", "shows": "...", "mood": "...", "things": [{"key": "kebab-key", "role": "prop | item | exit", "looks": "a few words"}]}`;
  let ask = prompt;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const answer = await askSparkJson(memo, { label: `photo-place#${attempt}`, prompt: ask, images: [image] });
    const parsed = Place.omit({ exits: true }).safeParse(answer);
    const issues = parsed.success ? (parsed.data.things.some((t) => t.role === 'exit') ? [] : ['no thing has role exit; the door is the exit']) : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    if (parsed.success && issues.length === 0) return { ...parsed.data, exits: [] };
    console.log(`  photo place try ${attempt}: ${issues.join('; ')}`);
    ask = `${prompt}\n\nYour last answer was:\n${JSON.stringify(answer)}\n\nFix: ${issues.join('; ')}`;
  }
  throw new Error('Spark could not read the photo into a place in 3 tries');
}

export function photoPaintPrompt(world: World, place: Place, brief?: Brief): string {
  const looks = place.things.filter((t) => t.role !== 'npc').map((t) => `- ${t.key}: ${brief?.looks[t.key] ?? t.looks}`);
  return `Repaint this photo as a finished background of a 2D point-and-click adventure game. Keep the camera and every object exactly where and as big as it is in the photo: same walls, same furniture, same door, same floor. Only the medium changes.

Style: ${world.style}
Mood: ${place.mood}
Objects to keep recognisable:
${looks.join('\n')}

Remove every person; paint the furniture and floor behind them. Keep the floor clear to walk on. No text or letters, no border.`;
}

export async function paintPhoto(memo: Memo, world: World, place: Place, photo: Buffer, brief?: Brief, take = 0): Promise<Buffer> {
  const painted = await museEdit(memo, { label: `paint:${place.key}`, prompt: photoPaintPrompt(world, place, brief), images: [photo], take });
  return sharp(painted).resize(FRAME.width, FRAME.height, { fit: 'fill' }).png().toBuffer();
}

// Looks feed every later painting (cast, the four model views, sprites), so they describe the person and not
// the photo: "lying against a headboard" in looks puts a headboard behind the figure in every view, and
// "legs not visible" leaves the painters to guess. This catches what the photo leaked into them.
const POSE_WORDS = /\b(not visible|out of (the )?frame|cropped|cut off|(from|at) the (chest|waist|shoulders)|chest[- ]up|waist[- ]up|lying|lies|reclin\w*|sitting|sits|seated|leaning|propped|headboard|pillows?|bed|sofa|couch|armchair|chair|desk|blanket|duvet|selfie|in the photo|camera)\b/gi;

/** The words in looks that are about the photo (pose, furniture, framing) rather than the person. */
export function poseWords(looks: string): string[] {
  return [...new Set([...looks.matchAll(POSE_WORDS)].map((m) => m[0].toLowerCase()))];
}

/** Spark describes the person in a photo head to toe, so world.json's hero is them, standing, whatever the photo shows. */
export async function describePerson(memo: Memo, photo: Buffer): Promise<{ key: string; looks: string }> {
  const prompt = `This photo shows the real person who will be the hero of a 2D point-and-click adventure, where they will stand and walk. Describe them head to toe as a game character standing on their feet: build, hair, face, beard or glasses, every piece of clothing with its colour, trousers or skirt, shoes. No name, no guesses about who they are.

Describe the person only, never the photo: not how they sit or lie, not the bed, chair or pillow, not how the photo frames them. When the photo does not show part of them (legs, trousers, shoes), choose plain ones that go with the rest and describe those as if seen; never write that something is not visible.

The key names who they are in the game (like the-developer), not where they are in the photo.

Reply with JSON only: {"key": "kebab-key like the-developer", "looks": "..."}`;
  let ask = prompt;
  let hero: { key: string; looks: string } | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const answer = await askSparkJson<{ key: string; looks: string }>(memo, { label: `hero-photo#${attempt}`, prompt: ask, images: [photo] });
    hero = World.shape.hero.parse(answer);
    const leaked = poseWords(`${hero.key.replace(/-/g, ' ')} ${hero.looks}`);
    if (!leaked.length) return hero;
    console.log(`  hero photo try ${attempt}: looks speak of the photo (${leaked.join(', ')})`);
    ask = `${prompt}\n\nYour last answer was:\n${JSON.stringify(answer)}\n\nFix: it describes the photo, not the person (${leaked.join(', ')}). Describe them standing, head to toe, with every piece of clothing as if seen.`;
  }
  return hero!;
}

/** Whether the photo shows the person standing with the whole body in frame, so the hero can be painted in that very pose. */
export async function photoStanding(memo: Memo, photo: Buffer): Promise<boolean> {
  const answer = await askSparkJson<{ standing?: unknown }>(memo, {
    label: 'hero-photo-pose', images: [photo],
    prompt: 'Does this photo show the person standing upright on their feet, with the whole body from the top of the head down to both feet inside the frame? Sitting, lying, leaning back, kneeling, or any part of the legs or feet cut off by the frame or hidden is no.\n\nReply with JSON only: {"standing": true or false}',
  });
  return answer.standing === true;
}

/** Upright, at most 1600 px on the long side, PNG: what Spark and Muse get. */
export function normalisePhoto(photo: Buffer): Promise<Buffer> {
  return sharp(photo).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
}
