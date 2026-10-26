// paint: blockin.png becomes painting.png through one Muse edit.
import sharp from 'sharp';
import type { Memo } from '../meta/memo.ts';
import { museEdit } from '../meta/muse.ts';
import type { Place, World } from '../world/schema.ts';
import type { Brief } from './brief.ts';
import { FRAME, type Layout } from './layout.ts';

const third = (x: number) => (x < FRAME.width / 3 ? 'left' : x > (2 * FRAME.width) / 3 ? 'right' : 'middle');

export function paintPrompt(world: World, place: Place, layout: Layout, brief?: Brief): string {
  const look = (key: string, fallback: string) => brief?.looks[key] ?? fallback;
  const masses = place.things
    .filter((t) => t.role !== 'npc')
    .map((t) => {
      const box = layout.things.find((b) => b.key === t.key)!;
      return `- the ${box.colour} mass on the ${third(box.x)}: ${look(t.key, t.looks)}`;
    });
  const floors = layout.floors.map((f) => `- the ${f.colour} area: ${look(f.key, f.is)}, open floor to walk on`);
  return `Paint this colour block-in as a finished background of a 2D point-and-click adventure game. Keep the composition: every mass stays where it is, at its size, and becomes what is listed.

Place: ${place.shows}
Mood: ${place.mood}
Style: ${world.style}

The masses:
${[...masses, ...floors].join('\n')}

Seen a little from above, like a stage. Keep the floor areas clear to walk on. No people, no animals, no text or letters, no border.`;
}

/** One Muse edit, scaled back to the layout frame (Muse answers larger than asked). */
export async function paintPlace(memo: Memo, world: World, place: Place, layout: Layout, blockin: Buffer, brief?: Brief, take = 0): Promise<Buffer> {
  const painted = await museEdit(memo, { label: `paint:${place.key}`, prompt: paintPrompt(world, place, layout, brief), images: [blockin], take });
  return sharp(painted).resize(FRAME.width, FRAME.height, { fit: 'fill' }).png().toBuffer();
}
