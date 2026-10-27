// layout.json: where things stand in a place, as a block-in for the painter.
// Spark lays it out; the gate checks it before any paint is spent on it.
import { z } from 'zod';
import { dilate, intersect, polygonMask } from '../image/raster.ts';
import { maskArea } from '../image/mask.ts';
import type { Memo } from '../meta/memo.ts';
import { askSparkJson } from '../meta/spark.ts';
import type { Place, World } from '../world/schema.ts';

export const FRAME = { width: 1200, height: 896 } as const;

const Colour = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const XY = z.tuple([z.number(), z.number()]);

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
  if (reach) issues.push(...reachIssues(layout, place));
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
  return issues;
}

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
- things: every thing as a box standing on the floor: x (centre), footY (where it touches the floor), width, height in px, metres (real height), colour (main colour); nearer things sit lower and are bigger; exits sit at the edge of a floor; every exit, item and person stands on a floor
- lights: up to 6 visible sources (lamps, fires, windows) with x, y, colour

Reply with JSON only:
{"horizon": 0, "sky": "#rrggbb", "ground": "#rrggbb",
 "floors": [{"key": "...", "is": "what the floor is", "colour": "#rrggbb", "outline": [[x, y], ...]}],
 "things": [{"key": "...", "colour": "#rrggbb", "x": 0, "footY": 0, "width": 0, "height": 0, "metres": 1.0}],
 "lights": [{"key": "...", "x": 0, "y": 0, "colour": "#rrggbb"}]}`;
}

/** With a photo, Spark measures where things already are instead of placing them. */
export async function layOut(memo: Memo, world: World, place: Place, photo?: Buffer): Promise<Layout> {
  const ask = () => (photo ? `${brief(world, place)}\n\nThe place already exists: it is the attached photo, ${FRAME.width}x${FRAME.height} px. Do not place anything; measure where each thing, floor and light is in it.` : brief(world, place));
  let prompt = ask();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const answer = await askSparkJson(memo, { label: `layout:${place.key}#${attempt}`, prompt, images: photo ? [photo] : [] });
    const parsed = Layout.safeParse(answer);
    const issues = parsed.success ? layoutIssues(parsed.data, place, !photo) : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    if (parsed.success && issues.length === 0) return parsed.data;
    console.log(`  ${place.key} layout try ${attempt}: ${issues.slice(0, 4).join('; ')}`);
    prompt = `${ask()}\n\nYour last answer was:\n${JSON.stringify(answer)}\n\nFix every one of these and reply with the whole JSON again:\n- ${issues.join('\n- ')}`;
  }
  throw new Error(`no valid layout for ${place.key} in 3 tries`);
}
