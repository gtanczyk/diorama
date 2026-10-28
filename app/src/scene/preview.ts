// A drawing brought to life at once, while the children are still drawing: a character as the figure the game
// will use (same prompt, same drawing, so cast finds it in the memo), a place or a thing as a quick painting.
import sharp from 'sharp';
import type { Memo } from '../meta/memo.ts';
import { museEdit } from '../meta/muse.ts';
import { KIDS_STYLE, type Drawn } from '../world/drawings.ts';
import type { World } from '../world/schema.ts';
import { paintFigure } from './cast.ts';
import { FRAME } from './layout.ts';

export async function previewDrawing(memo: Memo, drawn: Drawn, drawing: Buffer): Promise<Buffer> {
  if (drawn.kind === 'hero' || drawn.kind === 'npc' || drawn.kind === 'player') {
    const { figure } = await paintFigure(memo, { style: KIDS_STYLE } as World, { key: drawn.key, looks: drawn.looks }, 0, { drawing });
    return figure;
  }
  const prompt = drawn.kind === 'place'
    ? `This is a child's drawing on paper of a place. Paint it as a finished background of a 2D adventure game, so the child knows it at once: the same things where they drew them, their colours and shapes, only whole and alive, with depth and light. No paper, no table, no written names, no people, no text.\n\nPlace: ${drawn.looks}\nStyle: ${KIDS_STYLE}`
    : `This is a child's drawing on paper. Paint the thing in it alone, whole and centred on a plain pale background, as the child drew it: the same colours and shapes, only cleaner and alive. No paper, no table, no written names, no text.\n\nThing: ${drawn.looks}\nStyle: ${KIDS_STYLE}`;
  const painted = await museEdit(memo, { label: `preview:${drawn.key}`, prompt, images: [drawing] });
  return drawn.kind === 'place'
    ? sharp(painted).resize(FRAME.width, FRAME.height, { fit: 'fill' }).png().toBuffer()
    : sharp(painted).resize(900, 900, { fit: 'inside' }).png().toBuffer();
}
