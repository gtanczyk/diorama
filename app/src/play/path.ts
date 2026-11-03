// Walking on the geometry grid: snap a click to the floor, find a route, straighten it.
// No Node imports: the browser bundles this file.
import type { Geometry } from './geometry.ts';

export type Point = [number, number];

/** Cells in from the floor's edge that count as roomy: a walk keeps this far in where the floor allows. */
const ROOMY = 3;
/** The extra cost of a step onto a cell 0, 1, 2... cells in from the edge. */
const RIM_COST = [0, 2, 0.6, 0];

export class WalkGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  private open: Uint8Array;

  constructor(g: Pick<Geometry, 'cell' | 'walk'>) {
    this.cell = g.cell;
    this.rows = g.walk.length;
    this.cols = Math.max(...g.walk.map((r) => r.length));
    this.open = new Uint8Array(this.cols * this.rows);
    g.walk.forEach((row, r) => {
      for (let c = 0; c < row.length; c++) if (row[c] === '#') this.open[r * this.cols + c] = 1;
    });
  }

  isOpen(c: number, r: number): boolean {
    return c >= 0 && r >= 0 && c < this.cols && r < this.rows && this.open[r * this.cols + c] === 1;
  }

  walkable(x: number, y: number): boolean {
    return this.isOpen(Math.floor(x / this.cell), Math.floor(y / this.cell));
  }

  centre(c: number, r: number): Point {
    return [(c + 0.5) * this.cell, (r + 0.5) * this.cell];
  }

  /** The walkable cell nearest to (x, y), as a cell centre, or the point itself when it is walkable. */
  snap(x: number, y: number): Point | undefined {
    if (this.walkable(x, y)) return [x, y];
    const c0 = Math.floor(x / this.cell);
    const r0 = Math.floor(y / this.cell);
    const limit = Math.max(this.cols, this.rows);
    for (let ring = 1; ring < limit; ring++) {
      let best: Point | undefined;
      let bestD = Infinity;
      for (let r = r0 - ring; r <= r0 + ring; r++) {
        for (let c = c0 - ring; c <= c0 + ring; c++) {
          if (Math.max(Math.abs(r - r0), Math.abs(c - c0)) !== ring || !this.isOpen(c, r)) continue;
          const [cx, cy] = this.centre(c, r);
          const d = (cx - x) ** 2 + (cy - y) ** 2;
          if (d < bestD) [best, bestD] = [[cx, cy], d];
        }
      }
      if (best) return best;
    }
    return undefined;
  }

  /** True when every sample along the segment is on walkable floor. */
  clear(a: Point, b: Point): boolean {
    const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (this.cell / 3));
    for (let i = 0; i <= steps; i++) {
      const t = steps ? i / steps : 0;
      if (!this.walkable(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)) return false;
    }
    return true;
  }

  /**
   * Where a held direction (keys or a pad) takes a walker next, `step` long, or undefined when nothing is open that way.
   * Straight on if the floor is clear; else it slides along the wall (the two axes, then 45 degrees either side); else,
   * facing a gap a little to one side, it sidesteps toward the gap (up to two cells), so a doorway or a narrow way
   * between two things lets the walker through instead of snagging on a corner.
   */
  steer(from: Point, dir: Point, step: number): Point | undefined {
    const n = Math.hypot(dir[0], dir[1]);
    if (!n) return undefined;
    const [ux, uy] = [dir[0] / n, dir[1] / n];
    // A walker standing just off the floor (on a cell's edge, or left there by a talk) steers from the floor beside it.
    const at = this.walkable(...from) ? from : this.snap(...from);
    if (!at) return undefined;
    const to = (p: Point, vx: number, vy: number, len: number): Point => [p[0] + vx * len, p[1] + vy * len];
    const ways: Point[] = [[ux, uy], [Math.sign(ux), 0], [0, Math.sign(uy)], [ux - uy, uy + ux], [ux + uy, uy - ux]];
    for (const [x, y] of ways) {
      const l = Math.hypot(x, y);
      if (!l) continue;
      const t = to(at, x / l, y / l, step);
      if (this.clear(at, t)) return t;
    }
    // A gap to one side: the nearest sidestep from which the way ahead is clear.
    for (let d = this.cell / 4; d <= this.cell * 2; d += this.cell / 4) {
      for (const [px, py] of [[-uy, ux], [uy, -ux]] as Point[]) {
        const side = to(at, px, py, d);
        if (this.clear(at, side) && this.clear(side, to(side, ux, uy, step))) return to(at, px, py, Math.min(d, step));
      }
    }
    return undefined;
  }

  private edges: Uint8Array | undefined;

  /** Per cell, how many cells it is from the floor's edge (1 on the edge), up to ROOMY. */
  private edge(): Uint8Array {
    if (this.edges) return this.edges;
    const out = new Uint8Array(this.cols * this.rows);
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (!this.isOpen(c, r)) continue;
        let d = 1;
        for (; d < ROOMY; d++) {
          let shut = false;
          for (let k = -d; k <= d && !shut; k++) shut = !this.isOpen(c + k, r - d) || !this.isOpen(c + k, r + d) || !this.isOpen(c - d, r + k) || !this.isOpen(c + d, r + k);
          if (shut) break;
        }
        out[r * this.cols + c] = d;
      }
    }
    return (this.edges = out);
  }

  private edgeAt(x: number, y: number): number {
    const c = Math.floor(x / this.cell);
    const r = Math.floor(y / this.cell);
    return this.isOpen(c, r) ? this.edge()[r * this.cols + c] : 0;
  }

  /**
   * True when the segment is on the floor and, but within a cell or two of `ends`, `need` cells or more in from its
   * edge: a walk across a bridge keeps to the middle of the deck, not its rim over the water.
   */
  private roomyLine(a: Point, b: Point, need: number, ends: Point[]): boolean {
    const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (this.cell / 3));
    for (let i = 0; i <= steps; i++) {
      const t = steps ? i / steps : 0;
      const [x, y] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const e = this.edgeAt(x, y);
      if (!e) return false;
      if (e < need && !ends.some(([ex, ey]) => Math.hypot(ex - x, ey - y) <= 2.5 * this.cell)) return false;
    }
    return true;
  }

  /**
   * A* over 8 neighbours without cutting corners, then string-pulled. Empty when unreachable. Cells on the floor's
   * edge cost more, so the walk keeps off the rim of a deck or a bank, and straightening keeps the room it found.
   */
  route(from: Point, to: Point): Point[] {
    const a = this.snap(...from);
    const b = this.snap(...to);
    if (!a || !b) return [];
    if (this.roomyLine(a, b, ROOMY, [a, b])) return [b];
    const edge = this.edge();
    const cols = this.cols;
    const start = Math.floor(a[1] / this.cell) * cols + Math.floor(a[0] / this.cell);
    const goal = Math.floor(b[1] / this.cell) * cols + Math.floor(b[0] / this.cell);
    const g = new Float64Array(cols * this.rows).fill(Infinity);
    const came = new Int32Array(cols * this.rows).fill(-1);
    const closed = new Uint8Array(cols * this.rows);
    const heap = new MinHeap();
    const h = (i: number) => Math.hypot((i % cols) - (goal % cols), Math.floor(i / cols) - Math.floor(goal / cols));
    g[start] = 0;
    heap.push(start, h(start));
    while (heap.size) {
      const i = heap.pop();
      if (i === goal) break;
      if (closed[i]) continue;
      closed[i] = 1;
      const c = i % cols;
      const r = Math.floor(i / cols);
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if ((!dr && !dc) || !this.isOpen(c + dc, r + dr)) continue;
          if (dr && dc && (!this.isOpen(c + dc, r) || !this.isOpen(c, r + dr))) continue;
          const j = (r + dr) * cols + c + dc;
          const cost = g[i] + (dr && dc ? Math.SQRT2 : 1) * (1 + RIM_COST[edge[j]]);
          if (cost < g[j]) {
            g[j] = cost;
            came[j] = i;
            heap.push(j, cost + h(j));
          }
        }
      }
    }
    if (came[goal] < 0) return [];
    const cells: Point[] = [];
    for (let i = goal; i !== start; i = came[i]) cells.push(this.centre(i % cols, Math.floor(i / cols)));
    cells.reverse();
    cells[cells.length - 1] = b;
    return this.pull(a, cells);
  }

  /** Drops every waypoint the walker can skip in a straight line that keeps as far in from the edge as the route did. */
  private pull(from: Point, points: Point[]): Point[] {
    const out: Point[] = [];
    const ends = [from, points[points.length - 1]];
    const room = points.map(([x, y]) => (ends.some(([ex, ey]) => Math.hypot(ex - x, ey - y) <= 2.5 * this.cell) ? ROOMY : this.edgeAt(x, y)));
    let at = from;
    let i = 0;
    while (i < points.length) {
      let far = i;
      for (let j = points.length - 1; j > i; j--) {
        let need = ROOMY;
        for (let k = i; k <= j; k++) need = Math.min(need, room[k]);
        if (this.roomyLine(at, points[j], need, ends)) {
          far = j;
          break;
        }
      }
      out.push(points[far]);
      at = points[far];
      i = far + 1;
    }
    return out;
  }
}

class MinHeap {
  private items: number[] = [];
  private keys: number[] = [];
  get size() {
    return this.items.length;
  }
  push(item: number, key: number) {
    this.items.push(item);
    this.keys.push(key);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): number {
    const top = this.items[0];
    const lastItem = this.items.pop()!;
    const lastKey = this.keys.pop()!;
    if (this.items.length) {
      this.items[0] = lastItem;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.keys.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.keys.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number) {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
  }
}
