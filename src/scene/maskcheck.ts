// The mask check: Spark looks at the painting with each thing's mask box drawn and numbered, and says for
// each box whether the thing is really in it. A mask and its box can agree and both be on the wrong thing
// (Spark boxed the stone next to the paper boat, SAM cut the stone): only a look at the picture catches that.
// One Spark call per place, remembered in the memo like every other.
import sharp from 'sharp';
import { z } from 'zod';
import type { Memo } from '../meta/memo.ts';
import { askSparkJson } from '../meta/spark.ts';
import type { Rect } from '../image/raster.ts';
import { svgLabel } from '../image/overlay.ts';
import { FRAME } from './layout.ts';

export const MaskCheck = z.object({
  ok: z.boolean(),
  /** What Spark sees in the box instead, when it is not the thing. */
  seen: z.string().optional(),
  /** Where the thing really is, when Spark can find it. */
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable().optional(),
});
export type MaskCheck = z.infer<typeof MaskCheck>;

const Reply = z.object({ boxes: z.record(z.string(), MaskCheck) });

export async function checkMasks(memo: Memo, place: string, painting: Buffer, things: Array<{ key: string; looks: string; box?: Rect }>): Promise<Record<string, MaskCheck>> {
  const boxed = things.filter((t): t is typeof t & { box: Rect } => !!t.box);
  if (boxed.length === 0) return {};
  const svg = boxed.map((t, i) => {
    const [x0, y0, x1, y1] = t.box;
    return `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="none" stroke="#ff2bd6" stroke-width="3"/>${svgLabel(x0 + 3, Math.max(16, y0 - 4), String(i + 1), [255, 43, 214])}`;
  }).join('');
  const { width: W, height: H } = FRAME;
  const image = await sharp(painting).resize(W, H, { fit: 'fill' })
    .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${svg}</svg>`) }]).png().toBuffer();
  const list = boxed.map((t, i) => `${i + 1}. ${t.looks}`).join('\n');
  const prompt = `This painting (${W}x${H} px) has numbered pink boxes. Each box should hold the thing listed under its number:
${list}

For each number say whether that thing is really inside its box (most of it, not just its neighbour). If it is not, say in a few words what the box holds instead, and give the box [x0, y0, x1, y1] in pixels where the thing really is, or null if it is not painted anywhere.

Reply with JSON only: {"boxes": {"1": {"ok": true}, "2": {"ok": false, "seen": "a grey stone", "box": [0, 0, 0, 0]}}}`;
  const reply = Reply.parse(await askSparkJson(memo, { label: `maskcheck:${place}`, prompt, images: [image] }));
  return Object.fromEntries(boxed.flatMap((t, i) => (reply.boxes[String(i + 1)] ? [[t.key, reply.boxes[String(i + 1)]]] : [])));
}
