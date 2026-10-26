// Where a thing meets the floor. A standing thing hides the hero when his feet are behind its floor
// line, decided per column, so a slanted boat or a table seen from the corner hides him correctly.
import { maskArea, type Mask } from '../image/mask.ts';
import { bottomRows, components, maskBox, type Rect } from '../image/raster.ts';

export type XY = [number, number];

/** Blobs smaller than this don't hide anyone; they are specks or tiny details. */
export const MIN_OCCLUDER_PX = 900;

/**
 * The chain of the lowest points that bulges downward (y grows down): the floor contact of a
 * blob's bottom edge, bridging gaps between legs. Points must be sorted by x.
 */
export function lowerHull(points: XY[]): XY[] {
  const hull: XY[] = [];
  for (const p of points) {
    // Pop the last point while it lies above (smaller y than) the line from the one before it to p.
    while (hull.length >= 2) {
      const [ax, ay] = hull[hull.length - 2];
      const [bx, by] = hull[hull.length - 1];
      const cross = (bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax);
      if (cross >= 0) hull.pop();
      else break;
    }
    hull.push(p);
  }
  return hull;
}

/** Drops steep ends of the hull: they come from overhangs (a lantern arm, a roof) and not from the floor. */
export function trimSteepEnds(line: XY[]): XY[] {
  const steep = (a: XY, b: XY) => Math.abs(b[1] - a[1]) > 2 * Math.abs(b[0] - a[0]);
  let from = 0;
  let to = line.length - 1;
  while (to - from >= 1 && steep(line[from], line[from + 1])) from++;
  while (to - from >= 1 && steep(line[to - 1], line[to])) to--;
  return line.slice(from, to + 1);
}

/** The floor line of a blob: per-column bottoms, lower hull, steep ends trimmed. */
export function floorLine(blob: Mask): XY[] {
  const rows = bottomRows(blob);
  const points: XY[] = [];
  rows.forEach((y, x) => {
    if (y >= 0) points.push([x, y + 1]);
  });
  return trimSteepEnds(lowerHull(points));
}

export function lineYAt(line: XY[], x: number): number {
  if (x <= line[0][0]) return line[0][1];
  for (let i = 1; i < line.length; i++) {
    const [x1, y1] = line[i];
    if (x <= x1) {
      const [x0, y0] = line[i - 1];
      return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return line[line.length - 1][1];
}

export type Blob = {
  /** "barrel" for a single blob, "barrel#2" for the second largest of several. */
  key: string;
  thing: string;
  mask: Mask;
  box: Rect;
  line: XY[];
  baseY: number;
  /** Floor rows covered by the thing's foot, every few columns: [x, back, front]. */
  foot: [number, number, number][];
  /** Spans the whole frame height: always in front of the hero. */
  front: boolean;
};

/** The footprint is as deep as a third of the thing's width, at least 12 px. */
export const footDepth = (width: number) => Math.max(12, 0.35 * width);

export function blobsOf(thing: string, mask: Mask, step = 4): Blob[] {
  const blobs = components(mask).filter((b) => maskArea(b) >= MIN_OCCLUDER_PX);
  return blobs.map((b, i) => {
    const box = maskBox(b)!;
    const line = floorLine(b);
    const x0 = line[0][0];
    const x1 = line[line.length - 1][0];
    const depth = footDepth(x1 - x0);
    const foot: [number, number, number][] = [];
    for (let x = x0; x <= x1; x += step) {
      const front = Math.round(lineYAt(line, x));
      foot.push([x, Math.max(box[1], front - Math.round(depth)), front]);
    }
    return {
      key: blobs.length === 1 ? thing : `${thing}#${i + 1}`,
      thing,
      mask: b,
      box,
      line,
      baseY: Math.max(...line.map(([, y]) => y)),
      foot,
      front: box[1] <= 3 && box[3] >= mask.height - 4,
    };
  });
}

/** Fewer points for the same line: keeps the corners, drops points within `tolerance` px of a straight run. */
export function simplifyLine(line: XY[], tolerance = 1.5): XY[] {
  if (line.length <= 2) return line;
  const out: XY[] = [line[0]];
  let anchor = 0;
  for (let i = 2; i < line.length; i++) {
    const [ax, ay] = line[anchor];
    const [bx, by] = line[i];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const off = line.slice(anchor + 1, i).some(([px, py]) => Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len > tolerance);
    if (off) {
      anchor = i - 1;
      out.push(line[anchor]);
    }
  }
  out.push(line[line.length - 1]);
  return out;
}
