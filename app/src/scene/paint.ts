import { STYLE_REFERENCE_PROMPT } from '../world/style-reference.ts';
// paint: blockin.png becomes painting.png through one Muse edit.
import sharp from 'sharp';
import type { Memo } from '../meta/memo.ts';
import { museEdit } from '../meta/muse.ts';
import type { Place, World } from '../world/schema.ts';
import { fallsIn } from '../play/weather.ts';
import { paintedAnimals, type Brief } from './brief.ts';
import { shapeOf } from './blockin.ts';
import { FRAME, type Layout, type Shape } from './layout.ts';

/** Animals listed as masses are painted (a cow in its stall); any other animal is not. */
const noAnimals = (brief?: Brief) => {
  const keep = paintedAnimals(brief);
  return keep.length ? `no animals other than the ${keep.join(', ')} listed above (paint ${keep.length > 1 ? 'those' : 'that'} in, at rest)` : 'no animals';
};

const NOUN: Record<Shape, string> = { block: 'box', low: 'low wide box', post: 'thin post', tree: 'tree shape', arch: 'arch', round: 'round shape', steps: 'steps', flat: 'flat oval on the floor' };

/** Where a mass is, in the words a painter uses: across (fifths) and how far back it stands. */
export function whereIs(layout: Layout, box: Layout['things'][number]): string {
  const across = ['on the far left', 'left of centre', 'in the middle', 'right of centre', 'on the far right'][Math.min(4, Math.max(0, Math.floor((box.x / FRAME.width) * 5)))];
  const back = (box.footY - layout.horizon) / (FRAME.height - layout.horizon);
  return `${back < 0.3 ? 'at the back' : back < 0.65 ? 'halfway back' : 'at the front'}, ${across}`;
}

export function paintPrompt(world: World, place: Place, layout: Layout, brief?: Brief): string {
  const look = (key: string, fallback: string) => brief?.looks[key] ?? fallback;
  const masses = place.things
    .filter((t) => t.role !== 'npc')
    .map((t) => {
      const box = layout.things.find((b) => b.key === t.key)!;
      return `- the ${NOUN[shapeOf(box, t)]} ${whereIs(layout, box)}: ${look(t.key, t.looks)}`;
    });
  const floors = layout.floors.map((f) => `- the tiled floor area${layout.floors.length > 1 ? ` ${whereFloor(layout, f)}` : ''}: ${look(f.key, f.is)}, open floor to walk on`);
  return `Paint this sketch as a finished background of a 2D point-and-click adventure game. The sketch is the plan: every shape stays where it is, at its size, and becomes what is listed; its shadow is where it stands on the floor. Keep the horizon and the camera of the sketch. The tiles on the floors only show the perspective: paint the real ground there, not tiles.

Place: ${place.shows}
Mood: ${place.mood}
Style: ${world.style}

The shapes:
${[...masses, ...floors].join('\n')}

Seen a little from above, like a stage. Keep the floor areas clear to walk on. No people, ${noAnimals(brief)}, no text or letters, no border.${fallsIn(`${place.shows} ${place.mood}`) ? '\nThe rain or snow itself is animated over the picture later: paint no falling streaks, drops or flakes in the air, only what the weather leaves (wet sheen, puddles, snow lying on the ground).' : ''}`;
}

function whereFloor(layout: Layout, f: Layout['floors'][number]): string {
  const ys = f.outline.map(([, y]) => y), xs = f.outline.map(([x]) => x);
  const mid = { key: f.key, colour: '', x: (Math.min(...xs) + Math.max(...xs)) / 2, footY: (Math.min(...ys) + Math.max(...ys)) / 2, width: 0, height: 0, metres: 1 };
  return whereIs(layout, mid);
}

/** Children's drawings of the place or of things in it, as more images after the block-in. */
export type Drawing = { key: string; image: Buffer };

export function drawingsPrompt(place: Place, drawings: Drawing[]): string {
  if (drawings.length === 0) return '';
  const which = drawings.map((d, i) => `image ${i + 2} is ${d.key === place.key ? 'this place' : `the ${d.key}`}`);
  return `

The other images are children's drawings on paper: ${which.join(', ')}. Paint what they drew so the children know it at once: their colours, shapes and ideas. A drawing fills its paper, but its thing does not fill the place: paint each at its real size beside the others (a hat is smaller than a log, a person comes up to a door's top). The composition still comes only from the first image; leave out the paper, the table and any written names.`;
}

/** One Muse edit, scaled back to the layout frame (Muse answers larger than asked). */
export async function paintPlace(memo: Memo, world: World, place: Place, layout: Layout, blockin: Buffer, brief?: Brief, take = 0, drawings: Drawing[] = [], concept?: Buffer, styleReference?: Buffer): Promise<Buffer> {
  const prompt = paintPrompt(world, place, layout, brief) + drawingsPrompt(place, drawings)
    + (styleReference ? `\nImage ${drawings.length + 2}: ${STYLE_REFERENCE_PROMPT}` : '')
    + (concept ? '\nThe LAST image is the creator-approved concept for this place. Preserve its distinctive architecture, palette, materials and visual identity. The FIRST image remains the authoritative layout: adapt the approved appearance to those positions and clear walking areas. Do not add characters or extra objects from the concept.' : '');
  const painted = await museEdit(memo, { label: `paint:${place.key}`, prompt, images: [blockin, ...drawings.map((d) => d.image), ...(styleReference ? [styleReference] : []), ...(concept ? [concept] : [])], take });
  return sharp(painted).resize(FRAME.width, FRAME.height, { fit: 'fill' }).png().toBuffer();
}
