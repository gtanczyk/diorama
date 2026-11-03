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
  // The place's people stand in the game as figures of their own: one also painted into the background is a double.
  const cast = place.things.filter((t) => t.role === 'npc').map((t) => t.looks ?? t.key.replace(/-/g, ' '));
  const prompt = `This is a painted background (${FRAME.width}x${FRAME.height} px) for a 2D point-and-click adventure. It should show:
${expected.join('\n')}
The whole picture is meant to be: ${place.shows}

List at most 4 problems a player would notice, worst first:
- missing: a listed thing is not there, or a big part of the scene above is (a tall tower, a castle with two towers, a house on top): key "scene" for that
- wrong: it is there but does not look like its description
- flat: it is a plain block or smear instead of a painted object
- unwanted: people (any person or figure at all${cast.length ? `, even one that looks like ${cast.join(' or ')}: they are added over the picture later, so a painted one would be a double` : ''}), ${paintedAnimals(brief).length ? 'animals other than the listed ones' : 'animals'}, text, letters or a border that should not be there
For each give the region to repaint as [x0, y0, x1, y1] in pixels and one sentence on what to paint there. Never ask for text or letters. If the painting is fine, give no issues.

Never ask to paint a person in: the game adds its people over the picture.

Reply with JSON only: {"issues": [{"key": "...", "problem": "missing | wrong | flat | unwanted", "region": [0, 0, 0, 0], "fix": "..."}]}`;
  const parsed = Critique.parse(await askSparkJson(memo, { schema: Critique, label: `critic:${place.key}`, prompt, images: [painting] }));
  const found = { issues: parsed.issues.filter((i) => !addsPerson(i)) };
  // The critic weighs the whole picture and lets a figure pass when the place's words name one ("a child floats
  // candle boats"); people are asked about on their own, as every one of them is a double or a stranger.
  const people = await paintedPeople(memo, place.key, painting);
  const near = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < 120;
  const extra = people.filter((p) => !found.issues.some((i) => i.problem === 'unwanted' && near(i.region, p.box))).map((p) => ({
    key: 'person', problem: 'unwanted' as const, region: pad(p.box, 24),
    fix: `Paint out the ${p.what}: continue what is behind them (planks, water, wall), add nothing new`,
  }));
  return { issues: [...found.issues, ...extra].slice(0, 6) };
}

const PERSON = /\b(child|children|kid|boy|girl|man|woman|men|women|person|people|figure|keeper|seller|vendor|fisherman|sailor|someone|crowd|silhouette)s?\b/i;

/**
 * A fix that would paint a person in: the place's words often name its people ("a child sets candle boats on the
 * water"), and the critic asks for them as missing, but the game draws its people over the picture itself.
 */
export const addsPerson = (i: { problem: string; fix: string }) => i.problem !== 'unwanted' && /\b(paint|add|show|draw)\b/i.test(i.fix) && PERSON.test(i.fix);

const People = z.object({ people: z.array(z.object({ what: z.string(), box: z.tuple([z.number(), z.number(), z.number(), z.number()]) })).max(6) });

/** Every person or figure painted in, with a box: none belongs in a background, the game adds its people itself. */
export async function paintedPeople(memo: Memo, key: string, painting: Buffer): Promise<Array<{ what: string; box: [number, number, number, number] }>> {
  const prompt = `This is a painted background (${FRAME.width}x${FRAME.height} px) for a 2D adventure. It must show no people at all.
List every person or human figure painted in it: adults, children, sitting, crouching or far away, a silhouette in a window or a doorway. Not statues, scarecrows, posters or pictures of people.
For each give what it is in a few words ("a crouching child in a grey hoodie") and its box [x0, y0, x1, y1] in pixels, tight around the figure.
Reply with JSON only: {"people": [{"what": "...", "box": [0, 0, 0, 0]}]}`;
  try {
    const { people } = People.parse(await askSparkJson(memo, { schema: People, label: `people:${key}`, prompt, images: [painting] }));
    return people.filter((p) => p.box[2] - p.box[0] >= 12 && p.box[3] - p.box[1] >= 20);
  } catch {
    return [];
  }
}

const pad = (b: [number, number, number, number], n: number): [number, number, number, number] =>
  [Math.max(0, b[0] - n), Math.max(0, b[1] - n), Math.min(FRAME.width, b[2] + n), Math.min(FRAME.height, b[3] + n)];

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
  // A painting out (people, a border) and a person's own repaint are pasted as asked; the critic's other fixes are
  // grown to all Muse painted for them, or left out when that runs on past REGION_REACH and would be sliced.
  const asAsked = (i: Critique['issues'][number]) => i.problem === 'unwanted' || i.key === 'person';
  const own = found.issues.filter((i) => !asAsked(i));
  const { kept, dropped } = await critiqueRegions(painting, patched, own.map((i) => i.region));
  for (const r of dropped) {
    const i = own.find((o) => o.region === r);
    console.log(`  ${place.key}: left out the repaint of ${i?.key} at [${r.join(', ')}]: Muse painted it far past its region, and pasted it would be sliced at the edge`);
  }
  return pasteAlpha(painting, patched, await regionAlpha([...found.issues.filter(asAsked).map((i) => i.region), ...kept]));
}

/** A critic's regions grown to all Muse painted for them; one still cut at REGION_REACH is dropped, as it was asked. */
export async function critiqueRegions(painting: Buffer, patched: Buffer, regions: [number, number, number, number][]): Promise<{ kept: [number, number, number, number][]; dropped: [number, number, number, number][] }> {
  const grown = await grownRegions(painting, patched, regions);
  return { kept: grown.filter((g) => !g.cut).map((g) => g.region), dropped: regions.filter((_, i) => grown[i].cut) };
}

/** `patched` over `painting` inside the regions only (feathered), everything else untouched. */
export async function pasteRegions(painting: Buffer, patched: Buffer, regions: [number, number, number, number][]): Promise<Buffer> {
  return pasteAlpha(painting, patched, await regionAlpha(await wholeRegions(painting, patched, regions)));
}

/** How far a region may grow to take in the rest of what Muse painted across its edge. */
const REGION_REACH = 160;
const REGION_STEP = 12;

/**
 * The regions grown, side by side, while what Muse painted runs on across that side: a boat it moved a little to
 * the right was cut at the region's edge and faded into the sea. A side grows while the change just outside it is
 * well above the change Muse made everywhere (it redraws the whole picture a little), up to REGION_REACH px.
 */
export async function wholeRegions(painting: Buffer, patched: Buffer, regions: [number, number, number, number][]): Promise<[number, number, number, number][]> {
  return (await grownRegions(painting, patched, regions)).map((g) => g.region);
}

/** Each region grown as wholeRegions does, and whether Muse's change still runs on across a side at REGION_REACH. */
async function grownRegions(painting: Buffer, patched: Buffer, regions: [number, number, number, number][]): Promise<{ region: [number, number, number, number]; cut: boolean }[]> {
  const { width: W, height: H } = FRAME;
  const read = (b: Buffer) => sharp(b).resize(W, H, { fit: 'fill' }).removeAlpha().blur(3).raw().toBuffer();
  const [a, b] = await Promise.all([read(painting), read(patched)]);
  const diff = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) diff[i] = Math.abs(a[i * 3] - b[i * 3]) + Math.abs(a[i * 3 + 1] - b[i * 3 + 1]) + Math.abs(a[i * 3 + 2] - b[i * 3 + 2]);
  const sorted = Float32Array.from(diff).sort();
  const enough = Math.max(70, 3 * sorted[Math.floor(sorted.length / 2)]);
  // The mean change over a strip of the frame.
  const strip = (x0: number, y0: number, x1: number, y1: number) => {
    let [s, n] = [0, 0];
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) [s, n] = [s + diff[y * W + x], n + 1];
    return n ? s / n : 0;
  };
  return regions.map((r) => {
    let [x0, y0, x1, y1] = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
    const [l, t, rr, bb] = [x0, y0, x1, y1];
    // Only a side the change crosses: changed just inside the region's own edge, and just outside it.
    const crosses = { r: strip(x1 - REGION_STEP, y0, x1, y1) > enough, l: strip(x0, y0, x0 + REGION_STEP, y1) > enough, b: strip(x0, y1 - REGION_STEP, x1, y1) > enough, t: strip(x0, y0, x1, y0 + REGION_STEP) > enough };
    for (let k = 0; k < REGION_REACH / REGION_STEP; k++) {
      let grew = false;
      if (crosses.r && x1 < W && x1 - rr < REGION_REACH && strip(x1, y0, x1 + REGION_STEP, y1) > enough) [x1, grew] = [x1 + REGION_STEP, true];
      if (crosses.l && x0 > 0 && l - x0 < REGION_REACH && strip(x0 - REGION_STEP, y0, x0, y1) > enough) [x0, grew] = [x0 - REGION_STEP, true];
      if (crosses.b && y1 < H && y1 - bb < REGION_REACH && strip(x0, y1, x1, y1 + REGION_STEP) > enough) [y1, grew] = [y1 + REGION_STEP, true];
      if (crosses.t && y0 > 0 && t - y0 < REGION_REACH && strip(x0, y0 - REGION_STEP, x1, y0) > enough) [y0, grew] = [y0 - REGION_STEP, true];
      if (!grew) break;
    }
    const cut = (crosses.r && x1 < W && strip(x1, y0, x1 + REGION_STEP, y1) > enough) || (crosses.l && x0 > 0 && strip(x0 - REGION_STEP, y0, x0, y1) > enough)
      || (crosses.b && y1 < H && strip(x0, y1, x1, y1 + REGION_STEP) > enough) || (crosses.t && y0 > 0 && strip(x0, y0 - REGION_STEP, x1, y0) > enough);
    return { region: [Math.max(0, x0), Math.max(0, y0), Math.min(W, x1), Math.min(H, y1)] as [number, number, number, number], cut };
  });
}
