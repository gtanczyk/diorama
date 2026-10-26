// Walking on the geometry grid: snap a click to the floor, find a route, straighten it.
// No Node imports: the browser bundles this file.
import type { Geometry } from './geometry.ts';

export type Point = [number, number];

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

  /** A* over 8 neighbours without cutting corners, then string-pulled. Empty when unreachable. */
  route(from: Point, to: Point): Point[] {
    const a = this.snap(...from);
    const b = this.snap(...to);
    if (!a || !b) return [];
    if (this.clear(a, b)) return [b];
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
          const cost = g[i] + (dr && dc ? Math.SQRT2 : 1);
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

  /** Drops every waypoint the walker can skip in a straight line. */
  private pull(from: Point, points: Point[]): Point[] {
    const out: Point[] = [];
    let at = from;
    let i = 0;
    while (i < points.length) {
      let far = i;
      for (let j = points.length - 1; j > i; j--) {
        if (this.clear(at, points[j])) {
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
