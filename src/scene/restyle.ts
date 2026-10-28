// restyle: a place or a character painted in one style, repainted in another by one Muse edit that keeps
// every outline where it is, so what was measured on the old picture still fits the new one.
import sharp from 'sharp';
import type { Memo } from '../meta/memo.ts';
import { museEdit } from '../meta/muse.ts';
import type { Place } from '../world/schema.ts';
import type { Brief } from './brief.ts';
import { FRAME } from './layout.ts';
import type { Drawing } from './paint.ts';

const KEEP = 'Keep the composition exactly: the camera, and every object, wall, door, floor and path where it is, at its size and in its shape, so an outline traced on the old picture still fits the new one. Only the medium changes: brushwork, rendering, palette and how light and shadow are painted.';
/** Muse keeps too much of the old look by itself (a cartoon keeps its black outlines under oil paint): say what goes. */
const CHANGE = 'It must look truly painted in the new style, not the old picture with a filter over it: whatever the old style has and the new one does not (black outlines, flat fills, cel shading) goes, and the forms are painted the new way.';

export function restylePlacePrompt(place: Place, was: string, style: string, brief?: Brief, drawings: Drawing[] = []): string {
  const looks = place.things.filter((t) => t.role !== 'npc').map((t) => `- ${t.key}: ${brief?.looks[t.key] ?? t.looks}`);
  const which = drawings.map((d, i) => `image ${i + 2} is ${d.key === place.key ? 'this place' : `the ${d.key}`}`);
  return `Repaint this background of a 2D point-and-click adventure game in a new style. ${KEEP}

It is painted now as: ${was}
Paint it as: ${style}
${CHANGE}

Place: ${place.shows}
Mood: ${place.mood}
Things to keep recognisable, each where it is:
${looks.join('\n')}

Keep the floor clear to walk on. No people, no animals, no text or letters, no border.${which.length ? `

The other images are children's drawings on paper the game was made from: ${which.join(', ')}. Keep what they drew recognisable in the new style: their colours, shapes and ideas. The composition comes only from the first image; leave out the paper and any written names.` : ''}`;
}

/** The place's painting in the new style, at the layout frame. */
export async function restylePlace(memo: Memo, place: Place, painting: Buffer, was: string, style: string, brief?: Brief, take = 0, drawings: Drawing[] = []): Promise<Buffer> {
  const prompt = restylePlacePrompt(place, was, style, brief, drawings);
  // Muse traces crisp lines it is given, so a cartoon kept its black outlines under the oil paint: it gets the
  // painting a little soft, which keeps every shape where it is and leaves the edges for the new style to paint.
  const soft = await sharp(painting).blur(2.5).png().toBuffer();
  const painted = await museEdit(memo, { label: `restyle:${place.key}`, prompt, images: [soft, ...drawings.map((d) => d.image)], take });
  return sharp(painted).resize(FRAME.width, FRAME.height, { fit: 'fill' }).png().toBuffer();
}

export function restyleFigurePrompt(looks: string, was: string, style: string, drawn: boolean): string {
  return `Repaint this character of a 2D point-and-click adventure game in a new style. Keep the same character: face, hair, clothes, colours, body proportions and the exact pose, at the same place and size in the frame, so the outline matches the picture. Show the whole figure from head to feet. Only the medium changes.

Character: ${looks}
It is painted now as: ${was}
Paint it as: ${style}
${CHANGE}
${drawn ? '\nThe second image is the child\'s drawing the character came from: keep it recognisable to them in the new style, its colours, shapes and proportions.\n' : ''}
Plain flat light grey background, no floor, no shadow, no other people, no text.`;
}
