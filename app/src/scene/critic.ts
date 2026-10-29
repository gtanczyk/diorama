// The critic: Spark looks at the painting and names up to four regions to fix; Muse repaints
// the picture once, and only those regions are taken from it (Muse redraws everything on an edit).
import sharp from 'sharp';
import { z } from 'zod';
import type { Memo } from '../meta/memo.ts';
import { museEdit } from '../meta/muse.ts';
import { askSparkJson } from '../meta/spark.ts';
import type { Place } from '../world/schema.ts';
import { paintedAnimals, type Brief } from './brief.ts';
import { FRAME } from './layout.ts';
import { pasteAlpha } from './plates.ts';

export const Critique = z.object({
  issues: z.array(z.object({
    key: z.string(),
    problem: z.enum(['missing', 'wrong', 'flat', 'unwanted']),
    region: z.tuple([z.number(), z.number(), z.number(), z.number()]).describe('x0, y0, x1, y1'),
    fix: z.string(),
  })).max(4),
});
export type Critique = z.infer<typeof Critique>;

export async function critique(memo: Memo, place: Place, brief: Brief, painting: Buffer): Promise<Critique> {
  const expected = place.things.filter((t) => t.role !== 'npc').map((t) => `- ${t.key}: ${brief.looks[t.key] ?? t.looks}`);
  const prompt = `This is a painted background (${FRAME.width}x${FRAME.height} px) for a 2D point-and-click adventure. It should show:
${expected.join('\n')}
The whole picture is meant to be: ${place.shows}

List at most 4 problems a player would notice, worst first:
- missing: a listed thing is not there, or a big part of the scene above is (a tall tower, a castle with two towers, a house on top): key "scene" for that
- wrong: it is there but does not look like its description
- flat: it is a plain block or smear instead of a painted object
- unwanted: people, ${paintedAnimals(brief).length ? 'animals other than the listed ones' : 'animals'}, text, letters or a border that should not be there
For each give the region to repaint as [x0, y0, x1, y1] in pixels and one sentence on what to paint there. Never ask for text or letters. If the painting is fine, give no issues.

Reply with JSON only: {"issues": [{"key": "...", "problem": "missing | wrong | flat | unwanted", "region": [0, 0, 0, 0], "fix": "..."}]}`;
  return Critique.parse(await askSparkJson(memo, { schema: Critique, label: `critic:${place.key}`, prompt, images: [painting] }));
}

/** A soft-edged alpha mask covering the regions, so patches blend into the painting. */
function regionAlpha(regions: [number, number, number, number][], feather = 14): Promise<Buffer> {
  const { width: W, height: H } = FRAME;
  const clamp = (v: number, hi: number) => Math.max(0, Math.min(hi, v));
  const rects = regions.map(([x0, y0, x1, y1]) => {
    const [l, t, r, b] = [clamp(Math.min(x0, x1), W), clamp(Math.min(y0, y1), H), clamp(Math.max(x0, x1), W), clamp(Math.max(y0, y1), H)];
    return `<rect x="${l}" y="${t}" width="${r - l}" height="${b - t}" fill="#fff"/>`;
  });
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#000"/>${rects.join('')}</svg>`))
    .blur(feather).grayscale().raw().toBuffer();
}

/** Repaints the critique's regions. Returns the painting unchanged when there is nothing to fix. */
export async function repaint(memo: Memo, place: Place, painting: Buffer, found: Critique): Promise<Buffer> {
  if (found.issues.length === 0) return painting;
  const fixes = found.issues.map((i) => `- around x ${Math.round((i.region[0] + i.region[2]) / 2)}, y ${Math.round((i.region[1] + i.region[3]) / 2)}: ${i.fix}`);
  const prompt = `Repaint only these spots of this background and leave everything else exactly as it is, same style and light:
${fixes.join('\n')}
No people, no animals the fixes don't ask for, no text or letters.`;
  const patched = await museEdit(memo, { label: `repaint:${place.key}`, prompt, images: [painting] });
  return pasteRegions(painting, patched, found.issues.map((i) => i.region));
}

/** `patched` over `painting` inside the regions only (feathered), everything else untouched. */
export async function pasteRegions(painting: Buffer, patched: Buffer, regions: [number, number, number, number][]): Promise<Buffer> {
  return pasteAlpha(painting, patched, await regionAlpha(regions));
}
