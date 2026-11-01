// The walk grid: which 8 px cells the hero can stand in, which floor each belongs to, and whether
// every part of the floor can be reached from the start through a corridor at least 2 cells wide.
import type { Mask } from '../image/mask.ts';

export const CELL = 8;

export class Grid {
  readonly open: Uint8Array;
  /** Floor index per cell, -1 for none. */
  readonly zone: Int8Array;

  constructor(readonly cols: number, readonly rows: number) {
    this.open = new Uint8Array(cols * rows);
    this.zone = new Int8Array(cols * rows).fill(-1);
  }

  at(c: number, r: number) {
    return r * this.cols + c;
  }

  inside(c: number, r: number) {
    return c >= 0 && r >= 0 && c < this.cols && r < this.rows;
  }

  centre(i: number): [number, number] {
    return [((i % this.cols) + 0.5) * CELL, (Math.floor(i / this.cols) + 0.5) * CELL];
  }

  cellOf(x: number, y: number): number {
    const c = Math.min(this.cols - 1, Math.max(0, Math.floor(x / CELL)));
    const r = Math.min(this.rows - 1, Math.max(0, Math.floor(y / CELL)));
    return this.at(c, r);
  }

  count(cells = this.open) {
    return cells.reduce((n, v) => n + v, 0);
  }

  /** geometry.json rows: '#' walkable, '.' not; and the floor digit per cell. */
  rowsOut(): { walk: string[]; zone: string[] } {
    const walk: string[] = [];
    const zone: string[] = [];
    for (let r = 0; r < this.rows; r++) {
      let w = '';
      let z = '';
      for (let c = 0; c < this.cols; c++) {
        const i = this.at(c, r);
        w += this.open[i] ? '#' : '.';
        z += this.zone[i] >= 0 ? String(this.zone[i]) : '.';
      }
      walk.push(w);
      zone.push(z);
    }
    return { walk, zone };
  }

  /** Each of 4 neighbours inside the grid. */
  neighbours(i: number): number[] {
    const c = i % this.cols;
    const out: number[] = [];
    if (c > 0) out.push(i - 1);
    if (c < this.cols - 1) out.push(i + 1);
    if (i >= this.cols) out.push(i - this.cols);
    if (i < this.cols * (this.rows - 1)) out.push(i + this.cols);
    return out;
  }
}

/**
 * A cell is walkable when at least half its pixels are; its floor is the most common floor
 * among them. `floorOf` gives a pixel's floor index, or -1.
 */
export function gridFromPixels(walk: Mask, floorOf: (pixel: number) => number, floors: number): Grid {
  const g = new Grid(Math.ceil(walk.width / CELL), Math.ceil(walk.height / CELL));
  const votes = new Int32Array(floors);
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      votes.fill(0);
      let on = 0;
      let all = 0;
      for (let y = r * CELL; y < Math.min(walk.height, (r + 1) * CELL); y++) {
        for (let x = c * CELL; x < Math.min(walk.width, (c + 1) * CELL); x++) {
          const p = y * walk.width + x;
          all++;
          if (!walk.bits[p]) continue;
          on++;
          const f = floorOf(p);
          if (f >= 0) votes[f]++;
        }
      }
      const i = g.at(c, r);
      g.open[i] = on * 2 >= all ? 1 : 0;
      let best = -1;
      votes.forEach((v, f) => {
        if (v > 0 && (best < 0 || v > votes[best])) best = f;
      });
      g.zone[i] = best;
    }
  }
  fillZones(g);
  return g;
}

/** Every walkable cell takes a floor: one with none takes its nearest floored neighbour's. */
export function fillZones(g: Grid) {
  const queue: number[] = [];
  for (let i = 0; i < g.open.length; i++) {
    if (!g.open[i]) g.zone[i] = -1;
    else if (g.zone[i] >= 0) queue.push(i);
  }
  for (let q = 0; q < queue.length; q++) {
    for (const n of g.neighbours(queue[q])) {
      if (g.open[n] && g.zone[n] < 0) {
        g.zone[n] = g.zone[queue[q]];
        queue.push(n);
      }
    }
  }
}

/** Open cells that are part of a fully open 2x2 block: where the hero fits. */
export function roomy(g: Grid): Uint8Array {
  const out = new Uint8Array(g.open.length);
  for (let r = 0; r + 1 < g.rows; r++) {
    for (let c = 0; c + 1 < g.cols; c++) {
      const i = g.at(c, r);
      if (g.open[i] && g.open[i + 1] && g.open[i + g.cols] && g.open[i + g.cols + 1]) {
        out[i] = out[i + 1] = out[i + g.cols] = out[i + g.cols + 1] = 1;
      }
    }
  }
  return out;
}

/** Cells reachable from `from` over roomy cells. */
export function reach(g: Grid, from: number, cells = roomy(g)): Uint8Array {
  const seen = new Uint8Array(g.open.length);
  if (!cells[from]) return seen;
  const queue = [from];
  seen[from] = 1;
  for (let q = 0; q < queue.length; q++) {
    for (const n of g.neighbours(queue[q])) {
      if (cells[n] && !seen[n]) {
        seen[n] = 1;
        queue.push(n);
      }
    }
  }
  return seen;
}

/** Roomy islands as cell lists, largest first. */
export function islands(g: Grid, cells = roomy(g)): number[][] {
  const seen = new Uint8Array(g.open.length);
  const out: number[][] = [];
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i] || seen[i]) continue;
    const island = [i];
    seen[i] = 1;
    for (let q = 0; q < island.length; q++) {
      for (const n of g.neighbours(island[q])) {
        if (cells[n] && !seen[n]) {
          seen[n] = 1;
          island.push(n);
        }
      }
    }
    out.push(island);
  }
  return out.sort((a, b) => b.length - a.length);
}

/** The roomy cell nearest (x, y), searching outward ring by ring; undefined on an empty grid. */
export function nearestRoomy(g: Grid, x: number, y: number, cells = roomy(g)): number | undefined {
  const c0 = Math.floor(x / CELL);
  const r0 = Math.floor(y / CELL);
  for (let d = 0; d < Math.max(g.cols, g.rows); d++) {
    let best: number | undefined;
    let bestDist = Infinity;
    for (let r = r0 - d; r <= r0 + d; r++) {
      for (let c = c0 - d; c <= c0 + d; c++) {
        if (Math.max(Math.abs(c - c0), Math.abs(r - r0)) !== d || !g.inside(c, r) || !cells[g.at(c, r)]) continue;
        const dist = (c - c0) ** 2 + (r - r0) ** 2;
        if (dist < bestDist) [best, bestDist] = [g.at(c, r), dist];
      }
    }
    if (best !== undefined) return best;
  }
}

class Heap {
  private items: [number, number][] = [];
  get size() {
    return this.items.length;
  }
  push(cost: number, value: number) {
    const a = this.items;
    a.push([cost, value]);
    for (let i = a.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

export type Connected = {
  /** Cells opened to join islands to the start. */
  reopened: number;
  /** Islands too small to matter that were closed instead. */
  dropped: number;
  /** Islands of at least minIsland cells that no allowed path reaches. */
  stranded: number[][];
};

/**
 * Joins every island of at least `minIsland` roomy cells to the start, opening the cheapest path
 * of closed cells (2 cells wide); `cost(i)` is the price of opening cell i, Infinity where it must
 * stay closed. Smaller unreachable islands are closed: they are specks, not places to walk.
 */
export function connect(g: Grid, start: number, cost: (i: number) => number, minIsland = 20): Connected {
  const result: Connected = { reopened: 0, dropped: 0, stranded: [] };
  const given = new Set<number>();
  // A path along open cells too narrow to walk (a one-cell fringe) can't always be widened: when opening it reached
  // nothing new, the same island is joined again by a path that opens every cell it takes.
  let last = { island: -1, reached: -1 };
  let strict = false;
  for (let round = 0; round < 32; round++) {
    const cells = roomy(g);
    const reached = reach(g, start, cells);
    const away = islands(g, cells).filter((island) => !reached[island[0]] && island.length >= minIsland && !given.has(island[0]));
    if (away.length === 0) break;
    const count = reached.reduce((a, b) => a + b, 0);
    if (away[0][0] === last.island && count === last.reached) {
      if (strict) {
        result.stranded.push(away[0]);
        given.add(away[0][0]);
        strict = false;
        continue;
      }
      strict = true;
    } else strict = false;
    last = { island: away[0][0], reached: count };
    const target = new Uint8Array(g.open.length);
    away[0].forEach((i) => (target[i] = 1));

    const dist = new Float64Array(g.open.length).fill(Infinity);
    const prev = new Int32Array(g.open.length).fill(-1);
    const heap = new Heap();
    reached.forEach((v, i) => {
      if (v) {
        dist[i] = 0;
        heap.push(0, i);
      }
    });
    let hit = -1;
    while (heap.size) {
      const [d, i] = heap.pop();
      if (d > dist[i]) continue;
      if (target[i]) {
        hit = i;
        break;
      }
      for (const n of g.neighbours(i)) {
        const step = g.open[n] && (!strict || cells[n]) ? 0.01 : g.open[n] ? Math.max(0.01, cost(n)) : cost(n);
        if (!Number.isFinite(step) || d + step >= dist[n]) continue;
        dist[n] = d + step;
        prev[n] = i;
        heap.push(dist[n], n);
      }
    }
    if (hit < 0) {
      result.stranded.push(away[0]);
      given.add(away[0][0]);
      continue;
    }
    // Open the path and its right and lower neighbours, so it is two cells wide.
    for (let i = hit; i >= 0; i = prev[i]) {
      const atRightEdge = i % g.cols === g.cols - 1;
      for (const n of atRightEdge ? [i, i + g.cols] : [i, i + 1, i + g.cols, i + g.cols + 1]) {
        if (n < g.open.length && !g.open[n] && Number.isFinite(cost(n))) {
          g.open[n] = 1;
          result.reopened++;
        }
      }
    }
    fillZones(g);
  }
  // Whatever is still cut off goes. Thin fringes touching the reached floor stay, but a fringe is
  // never a way into another patch: the hero needs two cells to pass.
  const finalCells = roomy(g);
  const keep = reach(g, start, finalCells);
  for (const island of result.stranded) island.forEach((i) => (keep[i] = 1));
  const fringe = [...keep.keys()].filter((i) => keep[i]);
  for (const i of fringe) {
    for (const n of g.neighbours(i)) if (g.open[n] && !finalCells[n]) keep[n] = 1;
  }
  for (let i = 0; i < g.open.length; i++) {
    if (g.open[i] && !keep[i]) {
      g.open[i] = 0;
      g.zone[i] = -1;
      result.dropped++;
    }
  }
  return result;
}
