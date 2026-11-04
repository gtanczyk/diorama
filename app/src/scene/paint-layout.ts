// Check composition before SAM/derive can turn a moved path into plausible but wrong geometry.
import sharp from 'sharp';
import { z } from 'zod';
import type { Memo } from '../meta/memo.ts';
import { inputHash } from '../meta/memo.ts';
import { museEdit } from '../meta/muse.ts';
import { askSparkJson } from '../meta/spark.ts';
import type { Place } from '../world/schema.ts';
import type { Brief } from './brief.ts';
import { FRAME, type Layout } from './layout.ts';

const Box = z.tuple([z.number().min(0).max(FRAME.width), z.number().min(0).max(FRAME.height), z.number().min(0).max(FRAME.width), z.number().min(0).max(FRAME.height)])
  .refine(([l, t, r, b]) => r > l && b > t, 'box must have positive area');
export const PaintedLayout = z.object({
  horizon: z.number().min(0).max(FRAME.height),
  people: z.boolean(),
  things: z.array(z.object({ key: z.string(), box: Box.nullable(), approach: z.boolean(), why: z.string() })),
  floors: z.array(z.object({ key: z.string(), coverage: z.number().min(0).max(1), connected: z.boolean(), reachesEdges: z.boolean(), why: z.string() })),
});
export type PaintedLayout = z.infer<typeof PaintedLayout>;

export const paintingLayoutHash = (place: Place, layout: Layout, blockin: Buffer, painting: Buffer) =>
  // Removing a decorative click target without painting it out is a supported masks-only edit.
  // Its planned geometry and the pixels stay checked; changes to story targets still invalidate the report.
  inputHash('paint-layout-v1', JSON.stringify({ key: place.key, shows: place.shows, mood: place.mood, targets: place.things.filter((t) => t.role !== 'prop') }), JSON.stringify(layout), blockin, painting);

/** Numeric plan, shared by painting, comparison and repair. Decorative silhouette details may change. */
export function layoutContract(place: Place, layout: Layout): string {
  const boxes = layout.things.filter((b) => place.things.some((t) => t.key === b.key && t.role !== 'npc'))
    .map((b) => `- ${b.key}: box [${Math.round(b.x - b.width / 2)}, ${Math.round(b.footY - b.height)}, ${Math.round(b.x + b.width / 2)}, ${Math.round(b.footY)}]`);
  const floors = layout.floors.map((f) => `- ${f.key}: ${f.is}; polygon ${JSON.stringify(f.outline)}`);
  return `Composition contract (${FRAME.width}x${FRAME.height} pixels, x right, y down):
Horizon y=${layout.horizon}. Keep this camera and perspective, not just the scene's subject.
Object boxes [left, top, right, bottom]:
${boxes.join('\n')}
Walkable floor polygons:
${floors.join('\n')}
Keep the connected walking surfaces, their joins and their frame-edge exits in these positions. A floor must remain solid usable ground, never water, a drop, a railing or an obstacle. Leave an approach on connected ground beside every item and exit. Do not replace a nearby interactive object with a distant decorative copy. Do not invent extra bridges to compensate for moving objects. The first image controls composition; other references control appearance only.`;
}

/**
 * Spark's yes/no and its note disagree now and then: approach=false with "Continuous planks lead to it" rejected a
 * pier six times over. A no counts when its note names what is in the way; a no whose note names nothing in the way
 * is kept as drift (soft), and derive and verify measure the reach on the painting itself (SPOT_UNREACHABLE,
 * FLOOR_UNREACHABLE) and send real breaks to repair.
 */
const BLOCKED = /\b(no|not|never|without|cannot|can't|cant|isn't|doesn't|don't|nothing)\b|\bn't\b|water|sea\b|river|gap|drop|cliff|ledge|railing|fence|wall|barrier|block|obstruct|cut off|cut-off|sever|broken|break|missing|absent|unreach|inaccessib|isolat|separat|float|detach|disconnect|across|beyond|away from|moved|shifted|displaced|only (by|via|through)|too (steep|far|high|small|narrow)/i;
export const CONTRADICTED = "(Spark's note names nothing in the way)";
const saysBlocked = (why: string) => BLOCKED.test(why);

/** Fail closed on incomplete observations: an omitted floor is not evidence that it is connected. */
export function paintedLayoutIssues(place: Place, layout: Layout, seen: PaintedLayout): string[] {
  const issues: string[] = [];
  if (seen.people) issues.push('unwanted people painted into the background; the game adds its cast separately');
  if (Math.abs(seen.horizon - layout.horizon) > 70) issues.push(`camera horizon moved from ${layout.horizon} to ${Math.round(seen.horizon)}`);
  for (const t of place.things.filter((t) => t.role !== 'npc')) {
    const planned = layout.things.find((b) => b.key === t.key);
    if (!planned) { issues.push(`${t.key}: absent from plan`); continue; }
    const matches = seen.things.filter((s) => s.key === t.key);
    if (matches.length !== 1) { issues.push(`${t.key}: comparison must locate it exactly once`); continue; }
    const s = matches[0];
    if (!s.box) { issues.push(`${t.key}: not painted; ${s.why}`); continue; }
    const [l, top, r, bottom] = s.box;
    if (Math.abs((l + r) / 2 - planned.x) > Math.max(60, planned.width * 0.35)
      || Math.abs(bottom - planned.footY) > Math.max(55, planned.height * 0.4)) issues.push(`${t.key}: moved from its planned box to [${s.box.join(', ')}]; ${s.why}`);
    const w = (r - l) / planned.width, h = (bottom - top) / planned.height;
    if (w < 0.45 || w > 2.2 || h < 0.45 || h > 2.2) issues.push(`${t.key}: painted size differs too much from its planned box; ${s.why}`);
    if (t.role !== 'prop' && !s.approach) issues.push(`${t.key}: no usable approach on connected ground; ${s.why}${saysBlocked(s.why) ? '' : ` ${CONTRADICTED}`}`);
  }
  for (const f of layout.floors) {
    const matches = seen.floors.filter((s) => s.key === f.key);
    if (matches.length !== 1) { issues.push(`${f.key}: comparison must inspect this floor exactly once`); continue; }
    const s = matches[0];
    if (s.coverage < 0.6) issues.push(`${f.key}: only ${Math.round(s.coverage * 100)}% of its planned area is walkable ground; ${s.why}`);
    if (!s.connected) issues.push(`${f.key}: its planned connection to the main floor is broken; ${s.why}${saysBlocked(s.why) ? '' : ` ${CONTRADICTED}`}`);
    const edge = f.outline.some(([x, y]) => x <= 1 || x >= FRAME.width - 1 || y <= 1 || y >= FRAME.height - 1);
    if (edge && !s.reachesEdges) issues.push(`${f.key}: the planned route no longer reaches its frame edge; ${s.why}${saysBlocked(s.why) ? '' : ` ${CONTRADICTED}`}`);
  }
  return issues;
}

export async function inspectPaintedLayout(memo: Memo, place: Place, layout: Layout, blockin: Buffer, painting: Buffer, brief: Brief): Promise<PaintedLayout> {
  const prompt = `Compare image 1 (authoritative block-in plan) with image 2 (painted game background). Measure image 2, not image 1. Both are ${FRAME.width}x${FRAME.height}.
${layoutContract(place, layout)}
Descriptions: ${JSON.stringify(place.things.filter((t) => t.role !== 'npc').map((t) => ({ key: t.key, role: t.role, looks: brief.looks[t.key] ?? t.looks })))}
Return every listed non-NPC thing and every planned floor exactly once, with these exact keys.
For each thing: its actual tight painted box or null if missing; approach=true only if the player can walk up to it along visibly continuous solid ground from the main floor (props may be decorative); why describes the evidence, including water, railings or gaps that block it. Do not use the nearest unrelated floor or a remote decorative copy as an approach.
For each floor: coverage is the fraction of its PLANNED polygon still covered by the intended walkable surface in image 2 (not overall floor area elsewhere). connected=true only if it visibly joins the first floor via solid walkable surfaces. reachesEdges=true if it still reaches every frame edge its planned polygon touched; true when no frame edges were planned. Small painterly edge differences are fine; displaced or severed routes are not.
Horizon is the camera's perspective horizon in image 2, not the skyline or top stair. people=true if image 2 contains any painted person or human figure: the game adds its cast separately, so a composition repair must not add people.
Return JSON {"horizon":300,"people":false,"things":[{"key":"...","box":[0,0,100,100],"approach":true,"why":"..."}],"floors":[{"key":"...","coverage":0.95,"connected":true,"reachesEdges":true,"why":"..."}]}`;
  return PaintedLayout.parse(await askSparkJson(memo, { schema: PaintedLayout, label: `paint-layout:${place.key}`, prompt, images: [blockin, painting] }));
}

const REPAIRS = 1;
/**
 * Drift the game copes with: masks, depth and walk are measured from the painting itself, so a camera a little
 * higher, a thing a little off its box or a size off its block-in is no reason to repaint (Muse does it on almost
 * every painting; failing on it left new worlds with no painting at all). What breaks play still repaints: a
 * floor gone, cut off or not reaching its exit, a story thing missing or out of reach, people painted in.
 */
export const softIssue = (issue: string) => /^camera horizon moved|: moved from its planned box|: painted size differs too much/.test(issue) || issue.endsWith(CONTRADICTED);

export type LayoutAttempt = { seen: PaintedLayout; issues: string[] };
export class PaintingLayoutError extends Error {
  constructor(readonly attempts: LayoutAttempt[]) {
    super(`PAINT_LAYOUT_MISMATCH: ${attempts.at(-1)!.issues.join('; ')}. A composition repair was tried. Read place_status.paintingLayout; use paint_retry for a new take or layout_fix for a simpler connected plan (after 2 rejected plans in a row, paint_retry comes first). No floor has been invented to hide this mismatch.`);
  }
}

/** Full-frame repair: a moved camera/path cannot be fixed by pasting a little rectangle. Never publish a rejected candidate. */
export async function alignPainting(memo: Memo, place: Place, layout: Layout, blockin: Buffer, painting: Buffer, brief: Brief, take: number, fixes: string[] = []): Promise<{ painting: Buffer; attempts: LayoutAttempt[] }> {
  const attempts: LayoutAttempt[] = [];
  // One repair round: each is a full Muse repaint plus a Spark check (minutes per place); a second rarely saved
  // a painting the first could not, and the place then goes to the agent (layout_fix, paint_retry) anyway.
  for (let n = 0; n <= REPAIRS; n++) {
    const seen = await inspectPaintedLayout(memo, place, layout, blockin, painting, brief);
    const issues = paintedLayoutIssues(place, layout, seen);
    attempts.push({ seen, issues });
    if (!issues.some((i) => !softIssue(i))) {
      if (issues.length) console.log(`  ${place.key}: composition drift kept (the game measures the painting itself): ${issues.join('; ')}`);
      return { painting, attempts };
    }
    if (n === REPAIRS) throw new PaintingLayoutError(attempts);
    console.log(`  ${place.key}: composition repair ${n + 1}/${REPAIRS}: ${issues.join('; ')}`);
    const prompt = `Restore this game background to its planned composition. Image 1 is the authoritative spatial plan. Image 2 supplies ONLY the finished appearance, materials, palette and lighting. Repaint the whole composition where necessary, not a small patch. Preserve object identities and art style from image 2, but restore the camera, sizes, walking surfaces, joins and positions from image 1.
${layoutContract(place, layout)}
Object appearances: ${JSON.stringify(brief.looks)}
Measured problems to correct:\n${issues.map((i) => `- ${i}`).join('\n')}
Retain these requested details where compatible with the plan:\n${fixes.map((f) => `- ${f}`).join('\n')}
No people, no text, labels, diagram lines or borders. Do not turn the plan's flat colours or tiles into the final art. Do not add unplanned boardwalks over water to hide a displaced object. Repair round ${n + 1}.`;
    const candidate = await museEdit(memo, { label: `paint-align:${place.key}`, prompt, images: [blockin, painting], take });
    painting = await sharp(candidate).resize(FRAME.width, FRAME.height, { fit: 'fill' }).png().toBuffer();
  }
  throw new PaintingLayoutError(attempts);
}
