// Spark looks at the finished painting: where each thing really is, what kind of thing it is,
// and which grid cells are floor. Muse moves things away from the layout, so masks start from
// this, not from layout.json; the layout only fills in what Spark can't find.
import sharp from 'sharp';
import { z } from 'zod';
import { emptyMask, type Mask } from '../image/mask.ts';
import type { Rect } from '../image/raster.ts';
import type { Memo } from '../meta/memo.ts';
import { askSparkJson } from '../meta/spark.ts';
import type { Place } from '../world/schema.ts';
import type { Brief } from './brief.ts';
import { FRAME, type Layout } from './layout.ts';

/** How a thing meets the floor, which decides walking and hiding around it. */
export const KINDS = ['standing', 'wall', 'on-top', 'walk-on', 'flat'] as const;
export type Kind = (typeof KINDS)[number];

const Spot = z.object({
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
  kind: z.enum(KINDS),
  /** A two or three word noun phrase SAM can search for ("rowing boat"). */
  phrase: z.string().min(2),
  /** Another way to name it, tried when the first finds nothing ("street lantern" for "lamp post"). */
  also: z.string().optional(),
});
export const Spots = z.record(z.string(), Spot);
export type Spots = z.infer<typeof Spots>;

export async function locateThings(memo: Memo, place: Place, brief: Brief, painting: Buffer): Promise<Spots> {
  const painted = place.things.filter((t) => t.role !== 'npc');
  const prompt = `This is a painted background for a 2D point-and-click adventure (${FRAME.width}x${FRAME.height} px, x right, y down). For each thing below give:
- box: a tight box [x0, y0, x1, y1] around it in the painting, or null if it is not painted
- kind: how it meets the floor:
  standing = stands on the floor and people walk around it (barrel, table, tree, lamp post, tower, a boat on land or afloat on water)
  wall = hangs on or is part of a wall or backdrop, people never pass in front of its base (door, window, sign, cliff)
  on-top = rests on another thing (a pot on a table, a lamp on a crate)
  walk-on = people walk on it (rug, path, bridge, stairs, jetty)
  flat = lies flat and cannot be walked on (water, a pond, a hole); never something that rises above the ground or the water, like a boat
- phrase: two or three plain words naming what is painted, for an image search ("rowing boat", "oil can")
- also: another short name for it, in case the first finds nothing ("street lantern" for "lamp post")

Things:
${painted.map((t) => `- ${t.key}: ${brief.looks[t.key] ?? t.looks}`).join('\n')}

Reply with JSON only: {"<key>": {"box": [0, 0, 0, 0], "kind": "standing", "phrase": "...", "also": "..."}}`;
  // A grid drawn over the painting did not make the boxes tighter (tried on foghorn), so the painting goes in plain.
  const spots = Spots.parse(await askSparkJson(memo, { schema: Spots, label: `locate:${place.key}`, prompt, images: [painting] }));
  const missing = painted.filter((t) => !spots[t.key]).map((t) => t.key);
  if (missing.length) throw new Error(`locate ${place.key}: Spark skipped ${missing.join(', ')}`);
  return spots;
}

// The floor grid: 60 px cells, a letter per column from A, a number per row from 1.
export const GRID = 60;
const COLS = Math.ceil(FRAME.width / GRID);
const ROWS = Math.ceil(FRAME.height / GRID);

export const cellName = (col: number, row: number) => `${String.fromCharCode(65 + col)}${row + 1}`;

export function parseCell(name: string): [number, number] | undefined {
  const m = /^([A-Z])(\d{1,2})$/.exec(name.trim().toUpperCase());
  if (!m) return undefined;
  const col = m[1].charCodeAt(0) - 65;
  const row = Number(m[2]) - 1;
  return col < COLS && row >= 0 && row < ROWS ? [col, row] : undefined;
}

/** The painting with the labelled grid drawn over it, for Spark to name cells on. */
export function gridImage(painting: Buffer): Promise<Buffer> {
  const { width: W, height: H } = FRAME;
  const lines: string[] = [];
  for (let c = 1; c < COLS; c++) lines.push(`<line x1="${c * GRID}" y1="0" x2="${c * GRID}" y2="${H}"/>`);
  for (let r = 1; r < ROWS; r++) lines.push(`<line x1="0" y1="${r * GRID}" x2="${W}" y2="${r * GRID}"/>`);
  const labels: string[] = [];
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) labels.push(`<text x="${c * GRID + 3}" y="${r * GRID + 13}">${cellName(c, r)}</text>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<g stroke="#ffe600" stroke-opacity="0.8" stroke-width="1.5">${lines.join('')}</g>
<g font-family="sans-serif" font-size="12" font-weight="bold" fill="#ffe600" stroke="#000" stroke-width="2.5" paint-order="stroke">${labels.join('')}</g>
</svg>`;
  return sharp(painting).resize(W, H, { fit: 'fill' }).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
}

export function cellsMask(cells: string[]): Mask {
  const { width: W, height: H } = FRAME;
  const m = emptyMask(W, H);
  for (const name of cells) {
    const at = parseCell(name);
    if (!at) continue;
    const [x0, y0] = [at[0] * GRID, at[1] * GRID];
    for (let y = y0; y < Math.min(H, y0 + GRID); y++) m.bits.fill(1, y * W + x0, y * W + Math.min(W, x0 + GRID));
  }
  return m;
}

/** The box around the named cells, or undefined when none parse. */
export function cellsBox(cells: string[]): Rect | undefined {
  const at = cells.map(parseCell).filter((c) => c !== undefined);
  if (at.length === 0) return undefined;
  const cols = at.map(([c]) => c);
  const rows = at.map(([, r]) => r);
  return [Math.min(...cols) * GRID, Math.min(...rows) * GRID, Math.min(FRAME.width, (Math.max(...cols) + 1) * GRID), Math.min(FRAME.height, (Math.max(...rows) + 1) * GRID)];
}

export const FloorCells = z.record(z.string(), z.array(z.string()));

/** Spark names the cells that are mostly each floor; floors it can't see get an empty list. */
export async function markFloors(memo: Memo, place: Place, layout: Layout, brief: Brief, painting: Buffer): Promise<Record<string, string[]>> {
  const prompt = `This is a painted background for a 2D point-and-click adventure with a labelled grid over it: ${GRID} px cells, a letter per column (A at the left) and a number per row (1 at the top). For each floor below, list every cell that is mostly that floor: open ground where a person could stand. Leave out walls, sky, water, and cells mostly covered by things standing on the floor.

Floors:
${layout.floors.map((f) => `- ${f.key}: ${brief.looks[f.key] ?? f.is}`).join('\n')}

Reply with JSON only: {"<floor key>": ["C12", "D12", ...]}`;
  const marked = FloorCells.parse(await askSparkJson(memo, { schema: FloorCells, label: `floors:${place.key}`, prompt, images: [await gridImage(painting)] }));
  return Object.fromEntries(layout.floors.map((f) => [f.key, marked[f.key] ?? []]));
}
