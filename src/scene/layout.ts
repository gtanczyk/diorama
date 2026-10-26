// layout.json: where things stand in a place, as a block-in for the painter.
// Spark lays it out; the gate checks it before any paint is spent on it.
import { z } from 'zod';
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

export function layoutIssues(layout: Layout, place: Place): string[] {
  const { width: W, height: H } = FRAME;
  const issues: string[] = [];
  if (layout.horizon < 120 || layout.horizon > 520) issues.push(`horizon ${layout.horizon} should be between 120 and 520`);
  layout.floors.forEach((floor, i) => {
    if (floor.outline.some(([x, y]) => x < 0 || x > W || y < 0 || y > H)) issues.push(`floor ${floor.key}: keep the outline inside ${W}x${H}`);
    if (Math.min(...floor.outline.map(([, y]) => y)) < layout.horizon) issues.push(`floor ${floor.key} rises above the horizon at ${layout.horizon}`);
    if (i === 0 && Math.max(...floor.outline.map(([, y]) => y)) < H - 30) issues.push(`floor ${floor.key} is listed first, so it must reach the bottom edge (y >= ${H - 30})`);
  });
  for (const thing of place.things) if (!layout.things.some((t) => t.key === thing.key)) issues.push(`${thing.key} is missing`);
  for (const t of layout.things) {
    if (!place.things.some((thing) => thing.key === t.key)) issues.push(`${t.key} is not a thing of ${place.key}`);
    if (t.width < 40 || t.height < 40) issues.push(`${t.key}: at least 40x40 px, so a player can click it`);
    const inside = t.x + t.width / 3 > 0 && t.x - t.width / 3 < W && t.footY - t.height >= 0 && t.footY <= H;
    if (!inside) issues.push(`${t.key}: keep the box mostly inside the frame`);
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
- floors: 1 to 4 walkable areas below the horizon as outlines, nearest first; the first reaches the bottom edge; leave room to walk around things
- things: every thing as a box standing on the floor: x (centre), footY (where it touches the floor), width, height in px, metres (real height), colour (main colour); nearer things sit lower and are bigger; exits sit at the edge of a floor
- lights: up to 6 visible sources (lamps, fires, windows) with x, y, colour

Reply with JSON only:
{"horizon": 0, "sky": "#rrggbb", "ground": "#rrggbb",
 "floors": [{"key": "...", "is": "what the floor is", "colour": "#rrggbb", "outline": [[x, y], ...]}],
 "things": [{"key": "...", "colour": "#rrggbb", "x": 0, "footY": 0, "width": 0, "height": 0, "metres": 1.0}],
 "lights": [{"key": "...", "x": 0, "y": 0, "colour": "#rrggbb"}]}`;
}

export async function layOut(memo: Memo, world: World, place: Place): Promise<Layout> {
  let prompt = brief(world, place);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const answer = await askSparkJson(memo, { label: `layout:${place.key}#${attempt}`, prompt });
    const parsed = Layout.safeParse(answer);
    const issues = parsed.success ? layoutIssues(parsed.data, place) : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    if (parsed.success && issues.length === 0) return parsed.data;
    console.log(`  ${place.key} layout try ${attempt}: ${issues.slice(0, 4).join('; ')}`);
    prompt = `${brief(world, place)}\n\nYour last answer was:\n${JSON.stringify(answer)}\n\nFix every one of these and reply with the whole JSON again:\n- ${issues.join('\n- ')}`;
  }
  throw new Error(`no valid layout for ${place.key} in 3 tries`);
}
