// layout.json: where things stand in a place, as a block-in for the painter.
// Spark lays it out; the gate checks it before any paint is spent on it.
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { components, dilate, intersect, polygonMask, rectMask, subtract, unionAll } from '../image/raster.ts';
import { maskArea } from '../image/mask.ts';
import { inputHash, type Memo } from '../meta/memo.ts';
import { askSparkJson } from '../meta/spark.ts';
import type { Place, World } from '../world/schema.ts';

export const FRAME = { width: 1200, height: 896 } as const;

const Colour = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const XY = z.tuple([z.number(), z.number()]);

/** The silhouette a thing gets in the block-in: enough for Muse to keep it where it is and the size it is. */
export const SHAPES = ['block', 'low', 'post', 'tree', 'arch', 'round', 'steps', 'flat'] as const;
export type Shape = (typeof SHAPES)[number];

export const Layout = z.object({
  horizon: z.number(),
  sky: Colour,
  ground: Colour,
  floors: z.array(z.object({ key: z.string(), is: z.string(), colour: Colour, outline: z.array(XY).min(3) })).min(1).max(4),
  things: z.array(z.object({
    key: z.string(),
    colour: Colour,
    x: z.number().describe('centre'),
    footY: z.number().describe('where it meets the floor'),
    width: z.number(),
    height: z.number(),
    metres: z.number().positive(),
    shape: z.enum(SHAPES).optional().catch(undefined),
  })),
  lights: z.array(z.object({ key: z.string(), x: z.number(), y: z.number(), colour: Colour })).max(6),
});
export type Layout = z.infer<typeof Layout>;

/** `reach` off for a photo: the room is what it is. */
export function layoutIssues(layout: Layout, place: Place, reach = true): string[] {
  const { width: W, height: H } = FRAME;
  const issues: string[] = [];
  if (layout.horizon < 120 || layout.horizon > 520) issues.push(`horizon ${layout.horizon} should be between 120 and 520`);
  layout.floors.forEach((floor, i) => {
    if (floor.outline.some(([x, y]) => x < 0 || x > W || y < 0 || y > H)) issues.push(`floor ${floor.key}: keep the outline inside ${W}x${H}`);
    if (Math.min(...floor.outline.map(([, y]) => y)) < layout.horizon) issues.push(`floor ${floor.key} rises above the horizon at ${layout.horizon}`);
    if (i === 0 && Math.max(...floor.outline.map(([, y]) => y)) < H - 30) issues.push(`floor ${floor.key} is listed first, so it must reach the bottom edge (y >= ${H - 30})`);
  });
  if (reach) issues.push(...reachIssues(layout, place), ...closeUpIssues(layout));
  for (const thing of place.things) if (!layout.things.some((t) => t.key === thing.key)) issues.push(`${thing.key} is missing`);
  for (const t of layout.things) {
    if (!place.things.some((thing) => thing.key === t.key)) issues.push(`${t.key} is not a thing of ${place.key}`);
    if (t.width < 40 || t.height < 40) issues.push(`${t.key}: at least 40x40 px, so a player can click it`);
    const inside = t.x + t.width / 3 > 0 && t.x - t.width / 3 < W && t.footY - t.height >= 0 && t.footY <= H;
    if (!inside) issues.push(`${t.key}: keep the box mostly inside the frame`);
  }
  return issues;
}

/** Quarter-size floor masks: enough to tell which floors touch. */
const Q = 4;
function floorMasks(layout: Layout) {
  const { width: W, height: H } = FRAME;
  return layout.floors.map((f) => polygonMask(W / Q, H / Q, f.outline.map(([x, y]) => [x / Q, y / Q] as [number, number])));
}

/**
 * The hero walks: every floor has to join the first one (touching it, or through floors that do), and every
 * exit, item and person has to stand on a floor. A quay across a canal with the exit on it is a painting
 * nobody can play (ootb-test canal-steps); a bridge or steps between them is a floor of its own.
 */
export function reachIssues(layout: Layout, place: Place): string[] {
  const issues: string[] = [];
  const masks = floorMasks(layout);
  const near = masks.map((m) => dilate(m, 3));
  const joined = new Set([0]);
  for (let grew = true; grew;) {
    grew = false;
    masks.forEach((m, i) => {
      if (joined.has(i) || ![...joined].some((j) => maskArea(intersect(near[j], m)) > 0)) return;
      joined.add(i);
      grew = true;
    });
  }
  layout.floors.forEach((f, i) => {
    if (!joined.has(i)) issues.push(`floor ${f.key} doesn't touch ${layout.floors[0].key} or a floor that does: the hero can't get there (add the bridge, steps or path between them as a floor, or drop it)`);
  });
  const used = new Set(place.things.filter((t) => t.role !== 'prop').map((t) => t.key));
  for (const t of layout.things) {
    if (!used.has(t.key)) continue;
    const x = Math.round(Math.min(FRAME.width - 1, Math.max(0, t.x)) / Q), y = Math.round(Math.min(FRAME.height - 1, Math.max(0, t.footY)) / Q);
    const on = near.findIndex((m) => m.bits[Math.min(m.height - 1, y) * m.width + Math.min(m.width - 1, x)]);
    if (on < 0) issues.push(`${t.key}: its foot (${Math.round(t.x)}, ${Math.round(t.footY)}) is on no floor; the hero must be able to walk up to it`);
    else if (!joined.has(on)) issues.push(`${t.key} stands on ${layout.floors[on].key}, which the hero can't reach`);
  }
  if (issues.length === 0) issues.push(...blockedIssues(layout, place, masks));
  return issues;
}

/**
 * Floors that touch can still be cut apart by what stands on them: a wide market stall set right across
 * the only path to the canal (night-market lantern-market) leaves the path behind it unreachable. Each
 * standing thing's foot is in the way, as deep as derive will make it; exits (a path, stairs, a door)
 * and people are not, and small things are stepped round.
 */
export function blockedIssues(layout: Layout, place: Place, masks = floorMasks(layout)): string[] {
  const { width: W, height: H } = FRAME;
  const passable = new Set(place.things.filter((t) => t.role === 'exit' || t.role === 'npc').map((t) => t.key));
  // Low wide things (a bridge, a rug, still water) are walked on or over, not round.
  const blocks = layout.things.filter((t) => !passable.has(t.key) && t.metres >= 0.5 && t.height >= 0.5 * t.width).map((t) => {
    const depth = Math.max(12, 0.35 * t.width);
    return { key: t.key, mask: rectMask(W / Q, H / Q, [(t.x - t.width / 2) / Q, (t.footY - depth) / Q, (t.x + t.width / 2) / Q, t.footY / Q]) };
  });
  const walk = subtract(unionAll(W / Q, H / Q, masks), unionAll(W / Q, H / Q, blocks.map((b) => b.mask)));
  const parts = components(walk);
  const main = parts.reduce((best, c) => (maskArea(intersect(c, masks[0])) > maskArea(intersect(best, masks[0])) ? c : best), parts[0]);
  if (!main) return [];
  const reached = dilate(main, 2);
  const issues: string[] = [];
  layout.floors.forEach((f, i) => {
    if (i === 0 || maskArea(intersect(reached, subtract(masks[i], unionAll(W / Q, H / Q, blocks.map((b) => b.mask))))) > 0) return;
    const across = blocks.filter((b) => maskArea(intersect(b.mask, dilate(masks[i], 2))) > 0).map((b) => b.key);
    issues.push(`floor ${f.key} is cut off by ${across.join(', ') || 'things'} standing across the way to it: move ${across.length > 1 ? 'them' : 'it'} aside or widen the floor so the hero can walk round`);
  });
  const used = new Set(place.things.filter((t) => t.role !== 'prop').map((t) => t.key));
  for (const t of layout.things) {
    if (!used.has(t.key)) continue;
    const x = Math.round(Math.min(W - 1, Math.max(0, t.x)) / Q), y = Math.round(Math.min(H - 1, Math.max(0, t.footY)) / Q);
    // A thing on a table is reached at the table.
    const onTop = blocks.some((b) => b.key !== t.key && dilate(b.mask, 2).bits[y * b.mask.width + x]);
    if (!onTop && masks.some((m) => m.bits[y * m.width + x]) && !dilate(reached, 4).bits[y * reached.width + x]) issues.push(`${t.key}: things stand between the hero and it; leave a way to walk up to it`);
  }
  return issues;
}

/** The tallest a person may stand at the bottom of the picture, as the layout's things imply it. */
export const CLOSE_UP_MAX = 0.6;

/**
 * A camera too close: the things' sizes say how tall a 1.62 m person is at each depth, and at the bottom edge
 * that must leave the hero room to walk (a bakery laid out at 610 px came out 940 px painted).
 */
export function closeUpIssues(layout: Layout): string[] {
  const { height: H } = FRAME;
  const implied = layout.things
    .filter((t) => t.metres >= 0.5 && t.footY - layout.horizon > 40)
    .map((t) => ((t.height * 1.62) / t.metres / (t.footY - layout.horizon)) * (H - layout.horizon))
    .sort((a, b) => a - b);
  if (implied.length < 2) return [];
  const person = implied[Math.floor(implied.length / 2)];
  return person > CLOSE_UP_MAX * H
    ? [`the camera is too close: by the things' sizes a person at the bottom edge would be ${Math.round(person)} px tall (keep it under ${Math.round(CLOSE_UP_MAX * H)}): reduce height relative to metres, move feet toward the bottom edge, or lower the horizon y coordinate`]
    : [];
}

/** A drive place: a side view of a road that loops sideways, the car standing on it, the signs beside it. */
const DRIVE_LAYOUT = `
This place is a drive: the hero rides in the car along the road, seen from the side at about car height, and the scenery will stream past sideways in a loop. So:
- horizon between 300 and 420; the road runs straight across the whole frame from the left edge to the right edge, level, below the horizon: one floor, the road with its near and far kerb, from x 0 to x ${FRAME.width}, reaching the bottom edge
- the car stands on the road in the middle third, side on, wheels on the road, about a third of the frame wide
- road signs on posts stand on the far kerb of the road, spread left and right of the car, not behind it; other things sit in or on the car or at the roadside
- the scenery beside the road (buildings, palms, sea, hills) runs on past both frame edges, with nothing cut in half at an edge that matters

`;

function brief(world: World, place: Place): string {
  const { width: W, height: H } = FRAME;
  return `Lay out one place of a 2D point-and-click adventure as a block-in for a painter. The frame is ${W}x${H} px, x to the right, y down; the camera looks a little down at the place, like at a stage.

Style: ${world.style}
Place: ${place.shows}
Mood: ${place.mood}
Things (use these keys): ${place.things.map((t) => `${t.key} (${t.role}: ${t.looks})`).join('; ')}

Give:
- horizon: y of the horizon, or of where the back wall meets the floor (120 to 520)
- sky and ground: the main colour above and below it
- floors: 1 to 4 walkable areas below the horizon as outlines, nearest first; the first reaches the bottom edge; every other floor touches one listed before it (a bridge, steps or a path across water or a drop is a floor too), so the hero can walk everywhere; leave room to walk around things
- things: every thing as a box standing on the floor: x (centre), footY (where it touches the floor), width, height in px, metres (real height), colour (main colour), shape (its silhouette: block = a box, stall, cupboard; low = bench, table, boat, cart, bed; post = lamp, pole, sign, column; tree; arch = door, gate, archway, window, tunnel; round = barrel, pot, rock, bush, well; steps = stairs or steps; flat = lies on the floor: rug, water, tracks); nearer things sit lower and are bigger; exits sit at the edge of a floor; every exit, item and person stands on a floor; leave a way round every big thing, and never stand one across the only way to a floor
- lights: up to 6 visible sources (lamps, fires, windows) with x, y, colour
${place.kind === 'drive' ? DRIVE_LAYOUT : ''}Reply with JSON only:
{"horizon": 0, "sky": "#rrggbb", "ground": "#rrggbb",
 "floors": [{"key": "...", "is": "what the floor is", "colour": "#rrggbb", "outline": [[x, y], ...]}],
 "things": [{"key": "...", "colour": "#rrggbb", "x": 0, "footY": 0, "width": 0, "height": 0, "metres": 1.0, "shape": "block"}],
 "lights": [{"key": "...", "x": 0, "y": 0, "colour": "#rrggbb"}]}`;
}

/** Small positive boxes can be enlarged without moving their feet; every gate still runs afterwards. */
export function repairSmallBoxes(layout: Layout): Layout {
  return { ...layout, things: layout.things.map((t) => ({ ...t,
    width: t.width > 0 ? Math.max(40, t.width) : t.width,
    height: t.height > 0 ? Math.max(40, t.height) : t.height,
  })) };
}

/** With a photo, measure existing positions without resizing them. */
export async function layOut(memo: Memo, world: World, place: Place, photo?: Buffer, guidance?: string, concept?: Buffer): Promise<Layout> {
  const ask = () => (photo ? `${brief(world, place)}\n\nThe place already exists: it is the attached photo, ${FRAME.width}x${FRAME.height} px. Do not place anything; measure where each thing, floor and light is in it.` : brief(world, place));
  const base = ask() + (!photo && concept ? '\n\nThe attached image is the creator-approved concept for this place. Start from its camera and relative arrangement of the listed things, scaled to the output frame. Preserve the recognizable composition where possible, but adapt positions, sizes and floor connections to satisfy every walkability rule above. This is a concept, not a fixed photograph; do not copy inaccessible areas or invent extra things.' : '') + (guidance ? `\n\nLayout repair guidance: ${guidance}` : '');
  // Keep paid replies. An exhausted batch becomes feedback for the next batch, never an identical replay.
  const stateFile = path.join(memo.dir, 'layout-retries', `${inputHash(base, photo ?? '', ...(!photo && concept ? [concept] : []))}.json`);
  const saved = z.object({ round: z.number().int().nonnegative(), answer: z.unknown(), issues: z.array(z.string()) });
  let previous: z.infer<typeof saved> | undefined;
  if (fs.existsSync(stateFile)) previous = saved.parse(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
  const round = (previous?.round ?? 0) + 1;
  const feedback = (answer: unknown, issues: string[], attempt: number) => `${base}\n\nRepair batch ${round}, attempt ${attempt}. Your last answer was:\n${JSON.stringify(answer)}\n\nFix every one of these and reply with the whole JSON again:\n- ${issues.join('\n- ')}`;
  let prompt = previous ? feedback(previous.answer, previous.issues, 1) : base;
  let last: { answer: unknown; issues: string[] } | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const answer = await askSparkJson(memo, { label: `layout:${place.key}#${attempt}`, prompt, images: photo ? [photo] : concept ? [concept] : [] });
    const raw = Layout.safeParse(answer);
    const parsed = raw.success && !photo ? Layout.safeParse(repairSmallBoxes(raw.data)) : raw;
    const issues = parsed.success ? layoutIssues(parsed.data, place, !photo) : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    if (parsed.success && issues.length === 0) return parsed.data;
    console.log(`  ${place.key} layout try ${attempt}: ${issues.slice(0, 4).join('; ')}`);
    last = { answer: parsed.success ? parsed.data : answer, issues };
    prompt = feedback(last.answer, issues, attempt + 1);
  }
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const temp = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ round, ...last }));
  fs.renameSync(temp, stateFile);
  throw new Error(`no valid layout for ${place.key} in 3 tries: ${last!.issues.join('; ')}`);
}
