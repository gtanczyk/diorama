// weather: Spark reads what falls on a place (rain, snow, nothing) and which edges drip; SAM finds those edges
// and the water and puddles drops ring on. The page animates all of it (web/weather.ts), so the painting
// keeps only the marks of the weather (wet sheen, puddles) and never a frozen streak.
import { z } from 'zod';
import { maskArea, type Mask } from '../image/mask.ts';
import { bottomRows, components, dilate, subtract, unionAll } from '../image/raster.ts';
import type { Memo } from '../meta/memo.ts';
import { samFind } from '../meta/sam.ts';
import { askSparkJson } from '../meta/spark.ts';
import type { Geometry } from '../play/geometry.ts';
import { DEPTH_SCALE, type Depth } from '../play/shadow.ts';
import type { Weather, WeatherWish } from '../play/weather.ts';
import type { Place } from '../world/schema.ts';

const Read = z.object({
  fall: z.enum(['none', 'rain', 'snow']),
  strength: z.number().min(0).max(1).default(0.6),
  wind: z.number().min(-1).max(1).default(0),
  fog: z.number().min(0).max(1).default(0),
  drips: z.array(z.object({ phrase: z.string().min(2) })).max(4).default([]),
});

/** Drops along an edge at most this far apart, and at most this many per edge. */
const DRIP_EVERY = 22;
const DRIPS_PER_EDGE = 10;
/** A puddle larger than this share of the frame is SAM taking a whole wet floor. */
const PUDDLE_MAX = 0.08;

export type WeatherOut = { weather: Omit<Weather, 'ripples'>; ripples?: Mask };

export async function readWeather(memo: Memo, place: Place, painting: Buffer, g: Geometry, depth: Depth | undefined, dry: Mask, wish: WeatherWish): Promise<WeatherOut> {
  const prompt = `This is a painted background of a 2D point-and-click adventure game. The game animates the weather over it.
Place: ${place.shows}
Mood: ${place.mood}${wish.hint ? `\nThe author says: ${wish.hint}` : ''}

1. "fall": what falls from the sky in this scene right now: "rain", "snow" or "none". Say rain or snow only when the mood or the picture shows it falling now (wet ground alone after rain is "none"). Indoors, in a cave or under a roof it is "none".
2. "strength" 0..1: 0.3 drizzle, 0.6 steady rain, 1 a downpour (the same for snow).
3. "wind" -1..1: how much the fall slants, positive toward the right, 0 straight down.
4. "drips": up to 4 edges in the picture that water drips from in this weather: roof eaves, a gutter, an awning, a dripping pipe, a wet cave ceiling, the underside of a bridge. Only edges you can see. Each as a short noun phrase an image segmentation model can find ("slate roof", "wooden awning", "rusty pipe"). None when nothing drips.
5. "fog" 0..1: how much mist or fog drifts through the scene, as the picture and the mood show it: 0 clear air, 0.3 a haze over water or a valley, 0.7 thick fog. Indoors 0 unless steam or smoke fills the room.
Answer with JSON only: {"fall": "rain", "strength": 0.6, "wind": 0.1, "fog": 0, "drips": [{"phrase": "..."}]}`;
  const read = Read.parse(await askSparkJson(memo, { label: `weather:${place.key}`, prompt, images: [painting] }));
  const fall = wish.fall === 'auto' ? read.fall : wish.fall;
  const strength = wish.strength ?? (fall === 'none' ? 0 : read.strength);
  const [W, H] = [g.frame.width, g.frame.height];

  const drips: Weather['drips'] = [];
  for (const [i, d] of read.drips.entries()) {
    const hits = await samFind(memo, { label: `drip:${place.key}/${i}`, image: painting, prompt: d.phrase });
    const mask = unionAll(W, H, hits.map((h) => h.mask).filter((m) => maskArea(m) < 0.3 * W * H));
    const edge = dripEdge(mask, g, depth);
    if (edge.from.length) drips.push({ phrase: d.phrase, ...edge });
  }

  // Drops ring on water and puddles; rain only (snow settles).
  let ripples: Mask | undefined;
  if (fall === 'rain') {
    const water = unionAll(W, H, (await samFind(memo, { label: `rain-water:${place.key}`, image: painting, prompt: 'water' })).map((h) => h.mask));
    const puddles = (await samFind(memo, { label: `rain-puddle:${place.key}`, image: painting, prompt: 'puddle' })).map((h) => h.mask).filter((m) => maskArea(m) < PUDDLE_MAX * W * H);
    // SAM's water also takes wet planks and shiny cobbles: those are the floors and the things, where rings would float.
    const m = unionAll(W, H, [subtract(water, dry), ...puddles]);
    if (maskArea(m) > 400) ripples = m;
  }
  const fog = wish.fog ?? read.fog;
  // Mist drifts with the wind; with nothing falling the wind Spark read still moves it.
  return { weather: { fall, strength, wind: fall === 'none' && !fog ? 0 : read.wind, fog, drips }, ripples };
}

/**
 * Where an edge drips: the lowest pixel of the mask per column (a roof's eave, a pipe's underside), sampled
 * along it. Each drop lands on the floor row as far away as the edge (the depth map), else on the first
 * walkable cell below it, else a little under it.
 */
export function dripEdge(mask: Mask, g: Geometry, depth?: Depth): { from: Array<[number, number]>; to: number[] } {
  const main = components(mask).sort((a, b) => maskArea(b) - maskArea(a)).slice(0, 2);
  if (!main.length) return { from: [], to: [] };
  const bottom = bottomRows(unionAll(mask.width, mask.height, main));
  const cols: number[] = [];
  for (let x = 0; x < bottom.length; x += DRIP_EVERY) if (bottom[x] >= 0 && bottom[x] < g.frame.height - 4) cols.push(x);
  const pick = cols.length > DRIPS_PER_EDGE ? Array.from({ length: DRIPS_PER_EDGE }, (_, k) => cols[Math.round((k * (cols.length - 1)) / (DRIPS_PER_EDGE - 1))]) : cols;
  const from: Array<[number, number]> = [];
  const to: number[] = [];
  for (const x of pick) {
    const y = bottom[x] + 1;
    const land = landing(g, depth, x, y);
    if (land - y < 6) continue;
    from.push([x, y]);
    to.push(land);
  }
  return { from, to };
}

function landing(g: Geometry, depth: Depth | undefined, x: number, y: number): number {
  const H = g.frame.height;
  const col = Math.floor(x / g.cell);
  // The floor under the edge: the first walkable cell below it, and how far that floor runs toward the viewer.
  // An eave over a porch drips at the porch's front edge, not into the yard beyond, whatever the depth says.
  const floorOf = (r: number) => (g.zone ? g.zone[r]?.[col] : g.walk[r]?.[col] === '#' ? '#' : '.');
  let first = -1;
  for (let r = Math.floor(y / g.cell) + 1; r < g.walk.length; r++) if (g.walk[r][col] === '#') { first = r; break; }
  let front = first;
  if (first >= 0) while (front + 1 < g.walk.length && floorOf(front + 1) === floorOf(first) && floorOf(first) !== '.') front++;
  const runEnd = first >= 0 ? Math.min(H - 1, (front + 1) * g.cell) : H - 1;
  if (depth) {
    const c = Math.min(depth.w - 1, Math.floor(x / DEPTH_SCALE));
    const r = Math.min(depth.h - 1, Math.floor(y / DEPTH_SCALE));
    const rows = depth.rows[r * depth.w + c];
    const at = g.scale.horizonY + rows;
    if (rows > 0 && at > y + 6) return Math.min(runEnd, at);
  }
  if (first >= 0) return Math.min(H - 1, (first + 0.5) * g.cell);
  return Math.min(H - 1, y + 60);
}

/** The floors and standing things, grown a little: no water there. */
export function dryOf(width: number, height: number, masks: Mask[]): Mask {
  return dilate(unionAll(width, height, masks), 6);
}
