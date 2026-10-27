// Why a place cannot be walked, in terms the fix tools take: which floor patches the hero cannot reach,
// the shortest gap from each to where he can go (as 60 px cell names, the ones floor_cells takes), the
// things standing in that gap, and the spots off the reachable floor. place_view draws the same.
import type { Geometry } from '../play/geometry.ts';
import { emptyMask, type Mask } from '../image/mask.ts';
import { PALETTE, svgLabel, tintOver } from '../image/overlay.ts';
import { cellName, gridImage, GRID } from './locate.ts';
import { CELL, islands, nearestRoomy, reach, roomy } from './walk.ts';
import { gridOf } from './verify.ts';

type XY = [number, number];

export type Gap = {
  /** The nearest cell of the patch, and the nearest reached cell, in painting pixels. */
  from: XY;
  to: XY;
  px: number;
  /** 60 px cells the straight line between them crosses that are not walkable now. */
  cells: string[];
  /** Things whose box the line crosses, with their kind: a standing thing there is a wall to the hero. */
  things: Array<{ key: string; kind?: string }>;
};

export type Diagnosis = {
  start: { at: XY; onFloor: boolean };
  floors: Array<{ floor: number; cells: number; reached: number }>;
  /** Floor patches of 20 cells or more the hero cannot reach, largest first. */
  patches: Array<{ floors: number[]; cells: number; area: string[]; gap: Gap | null }>;
  /** Stand spots off the reachable floor, with the nearest reachable spot. */
  spots: Array<{ thing: string; at: XY; nearest: XY | null }>;
};

const cell60 = ([x, y]: XY) => cellName(Math.floor(x / GRID), Math.floor(y / GRID));
const round = ([x, y]: XY): XY => [Math.round(x), Math.round(y)];

export function diagnose(g: Geometry): Diagnosis {
  const grid = gridOf(g);
  const cells = roomy(grid);
  const start = grid.cellOf(...g.start);
  const reached = reach(grid, start, cells);
  const zones = new Map<number, { cells: number; reached: number }>();
  grid.zone.forEach((z, i) => {
    if (z < 0 || !grid.open[i]) return;
    const f = zones.get(z) ?? { cells: 0, reached: 0 };
    f.cells++;
    if (reached[i]) f.reached++;
    zones.set(z, f);
  });
  // The edge of the reached floor: the only cells a bridge can land on.
  const shore = [...reached.keys()].filter((i) => reached[i] && grid.neighbours(i).some((n) => !reached[n]));
  const patches = islands(grid, cells).filter((p) => p.length >= 20 && !reached[p[0]]).map((p) => {
    const edge = p.filter((i) => grid.neighbours(i).some((n) => !cells[n]));
    let best: { a: number; b: number; d: number } | null = null;
    for (const a of edge) {
      const [ax, ay] = grid.centre(a);
      for (const b of shore) {
        const [bx, by] = grid.centre(b);
        const d = Math.hypot(ax - bx, ay - by);
        if (!best || d < best.d) best = { a, b, d };
      }
    }
    const floors = [...new Set(p.map((i) => grid.zone[i]).filter((z) => z >= 0))].sort();
    const area = [...new Set(p.map((i) => cell60(grid.centre(i))))].sort();
    if (!best) return { floors, cells: p.length, area, gap: null };
    const from = grid.centre(best.a);
    const to = grid.centre(best.b);
    const crossed = new Set<string>();
    const things = new Map<string, string | undefined>();
    const steps = Math.max(1, Math.ceil(best.d / (CELL / 2)));
    for (let s = 0; s <= steps; s++) {
      const at: XY = [from[0] + ((to[0] - from[0]) * s) / steps, from[1] + ((to[1] - from[1]) * s) / steps];
      if (!grid.open[grid.cellOf(...at)]) crossed.add(cell60(at));
      for (const t of g.things) {
        const [x0, y0, x1, y1] = t.box;
        if (at[0] >= x0 && at[0] <= x1 && at[1] >= y0 && at[1] <= y1) things.set(t.key, t.kind);
      }
    }
    const gap: Gap = { from: round(from), to: round(to), px: Math.round(best.d), cells: [...crossed], things: [...things].map(([key, kind]) => ({ key, ...(kind && { kind }) })) };
    return { floors, cells: p.length, area: area.slice(0, 24), gap };
  });
  const spots = g.things.filter((t) => !reached[grid.cellOf(...t.stand)]).map((t) => {
    const near = nearestRoomy(grid, t.stand[0], t.stand[1], reached);
    return { thing: t.key, at: round(t.stand), nearest: near === undefined ? null : round(grid.centre(near)) };
  });
  return {
    start: { at: round(g.start), onFloor: !!cells[start] },
    floors: [...zones].sort(([a], [b]) => a - b).map(([floor, f]) => ({ floor, ...f })),
    patches,
    spots,
  };
}

/** The painting with the 60 px cell grid, reached floor in green, unreached floor in red, gaps and spots drawn. */
export async function diagnosisPicture(painting: Buffer, g: Geometry, d: Diagnosis): Promise<Buffer> {
  const grid = gridOf(g);
  const reached = reach(grid, grid.cellOf(...g.start), roomy(grid));
  const { width: W, height: H } = g.frame;
  const fill = (pick: (i: number) => boolean): Mask => {
    const m = emptyMask(W, H);
    grid.open.forEach((v, i) => {
      if (!v || !pick(i)) return;
      const [cx, cy] = grid.centre(i);
      for (let y = cy - CELL / 2; y < Math.min(H, cy + CELL / 2); y++) m.bits.fill(1, y * W + cx - CELL / 2, y * W + Math.min(W, cx + CELL / 2));
    });
    return m;
  };
  const svg: string[] = [];
  for (const p of d.patches) {
    if (!p.gap) continue;
    const { from, to } = p.gap;
    svg.push(`<line x1="${from[0]}" y1="${from[1]}" x2="${to[0]}" y2="${to[1]}" stroke="#ffe600" stroke-width="5" stroke-dasharray="10 6"/>`);
    const label = `gap ${p.gap.px}px: ${p.gap.cells.join(' ') || 'open'}`;
    // Kept inside the frame: a gap at the edge would push its words off the picture.
    svg.push(svgLabel(Math.min((from[0] + to[0]) / 2 + 8, W - 9 * label.length), (from[1] + to[1]) / 2 - 8, label, [255, 230, 0]));
  }
  for (const s of d.spots) {
    svg.push(`<circle cx="${s.at[0]}" cy="${s.at[1]}" r="8" fill="#f33" stroke="#000" stroke-width="2"/>`, svgLabel(s.at[0] + 10, s.at[1] + 5, s.thing, [255, 90, 90]));
    if (s.nearest) svg.push(`<line x1="${s.at[0]}" y1="${s.at[1]}" x2="${s.nearest[0]}" y2="${s.nearest[1]}" stroke="#f33" stroke-width="3" stroke-dasharray="6 4"/>`);
  }
  svg.push(`<circle cx="${g.start[0]}" cy="${g.start[1]}" r="10" fill="#3f6" stroke="#000" stroke-width="2"/>`, svgLabel(g.start[0] + 12, g.start[1] + 5, 'start', [80, 255, 120]));
  const tinted = await tintOver(await gridImage(painting), [
    { mask: fill((i) => !!reached[i]), rgb: PALETTE[4], alpha: 0.28 },
    { mask: fill((i) => !reached[i]), rgb: PALETTE[0], alpha: 0.4 },
  ], svg.join(''));
  return tinted;
}
