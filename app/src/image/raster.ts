// Pixel arithmetic on masks: boxes, overlaps, blobs, polygons. Pure code, no images on disk.
import { emptyMask, maskArea, type Mask } from './mask.ts';

/** [x0, y0, x1, y1] in pixels; x1 and y1 are exclusive. */
export type Rect = [number, number, number, number];

export const rectArea = ([x0, y0, x1, y1]: Rect) => Math.max(0, x1 - x0) * Math.max(0, y1 - y0);

export function rectIou(a: Rect, b: Rect): number {
  const inter = rectArea([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
  const union = rectArea(a) + rectArea(b) - inter;
  return union > 0 ? inter / union : 0;
}

/** Sorted corners, clamped to the frame and rounded to whole pixels. */
export function clampRect([x0, y0, x1, y1]: Rect, width: number, height: number): Rect {
  const cx = (v: number) => Math.round(Math.max(0, Math.min(width, v)));
  const cy = (v: number) => Math.round(Math.max(0, Math.min(height, v)));
  return [cx(Math.min(x0, x1)), cy(Math.min(y0, y1)), cx(Math.max(x0, x1)), cy(Math.max(y0, y1))];
}

export function growRect([x0, y0, x1, y1]: Rect, by: number): Rect {
  const dx = ((x1 - x0) * (by - 1)) / 2;
  const dy = ((y1 - y0) * (by - 1)) / 2;
  return [x0 - dx, y0 - dy, x1 + dx, y1 + dy];
}

/** The smallest rect around the set pixels, or undefined for an empty mask. */
export function maskBox(m: Mask): Rect | undefined {
  let x0 = m.width, y0 = m.height, x1 = -1, y1 = -1;
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      if (!m.bits[y * m.width + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return x1 < 0 ? undefined : [x0, y0, x1 + 1, y1 + 1];
}

export function rectMask(width: number, height: number, rect: Rect): Mask {
  const m = emptyMask(width, height);
  const [x0, y0, x1, y1] = clampRect(rect, width, height);
  for (let y = y0; y < y1; y++) m.bits.fill(1, y * width + x0, y * width + x1);
  return m;
}

/** Even-odd scanline fill of a polygon given as [x, y] points. */
export function polygonMask(width: number, height: number, points: [number, number][]): Mask {
  const m = emptyMask(width, height);
  for (let y = 0; y < height; y++) {
    const cy = y + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const [ax, ay] = points[i];
      const [bx, by] = points[(i + 1) % points.length];
      if ((ay <= cy) !== (by <= cy)) xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const from = Math.max(0, Math.ceil(xs[i] - 0.5));
      const to = Math.min(width, Math.ceil(xs[i + 1] - 0.5));
      if (to > from) m.bits.fill(1, y * width + from, y * width + to);
    }
  }
  return m;
}

function combine(a: Mask, b: Mask, op: (x: number, y: number) => number): Mask {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`mask sizes differ: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  const out = emptyMask(a.width, a.height);
  for (let i = 0; i < out.bits.length; i++) out.bits[i] = op(a.bits[i], b.bits[i]);
  return out;
}

export const union = (a: Mask, b: Mask) => combine(a, b, (x, y) => x | y);
export const intersect = (a: Mask, b: Mask) => combine(a, b, (x, y) => x & y);
export const subtract = (a: Mask, b: Mask) => combine(a, b, (x, y) => x & (1 - y));

export function unionAll(width: number, height: number, masks: Mask[]): Mask {
  return masks.reduce(union, emptyMask(width, height));
}

export function maskIou(a: Mask, b: Mask): number {
  let inter = 0, either = 0;
  for (let i = 0; i < a.bits.length; i++) {
    inter += a.bits[i] & b.bits[i];
    either += a.bits[i] | b.bits[i];
  }
  return either > 0 ? inter / either : 0;
}

/** Grows (r > 0) or shrinks (r < 0) a mask by a square of |r| px, as two separable passes of running counts. */
export function dilate(m: Mask, r: number): Mask {
  if (r === 0) return { ...m, bits: m.bits.slice() };
  const grow = r > 0;
  const k = Math.abs(r);
  const { width: W, height: H } = m;
  // One line at a time (a row, or a column with stride W): a pixel is set when any pixel within k is (growing),
  // or when all 2k+1 are, inside the frame (shrinking: outside the frame counts as empty, so it eats in from the edges).
  const pass = (src: Uint8Array, along: 'x' | 'y') => {
    const out = new Uint8Array(src.length);
    const [lines, len, step, lineStep] = along === 'x' ? [H, W, 1, W] : [W, H, W, 1];
    const sum = new Int32Array(len + 1);
    for (let l = 0; l < lines; l++) {
      const base = l * lineStep;
      for (let i = 0; i < len; i++) sum[i + 1] = sum[i] + src[base + i * step];
      for (let i = 0; i < len; i++) {
        const lo = i - k;
        const hi = i + k;
        const n = sum[Math.min(len, hi + 1)] - sum[Math.max(0, lo)];
        out[base + i * step] = grow ? (n > 0 ? 1 : 0) : lo >= 0 && hi < len && n === 2 * k + 1 ? 1 : 0;
      }
    }
    return out;
  };
  return { width: W, height: H, bits: pass(pass(m.bits, 'x'), 'y') };
}

/** 4-connected blobs, largest first. */
export function components(m: Mask): Mask[] {
  const { width: W, height: H } = m;
  const label = new Int32Array(W * H).fill(-1);
  const blobs: number[][] = [];
  const stack: number[] = [];
  for (let start = 0; start < m.bits.length; start++) {
    if (!m.bits[start] || label[start] >= 0) continue;
    const pixels: number[] = [];
    label[start] = blobs.length;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      pixels.push(i);
      const x = i % W;
      for (const n of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) {
        if (n >= 0 && n < W * H && m.bits[n] && label[n] < 0) {
          label[n] = blobs.length;
          stack.push(n);
        }
      }
    }
    blobs.push(pixels);
  }
  return blobs.sort((a, b) => b.length - a.length).map((pixels) => {
    const blob = emptyMask(W, H);
    for (const i of pixels) blob.bits[i] = 1;
    return blob;
  });
}

/** Drops blobs smaller than `minPx`. */
export function withoutSpecks(m: Mask, minPx: number): Mask {
  return unionAll(m.width, m.height, components(m).filter((c) => maskArea(c) >= minPx));
}

/** For each column of the mask, its lowest set row (-1 where the column is empty). */
export function bottomRows(m: Mask): Int32Array {
  const rows = new Int32Array(m.width).fill(-1);
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) if (m.bits[y * m.width + x]) rows[x] = y;
  }
  return rows;
}

/**
 * Fills the holes of a mask: unset regions it closes on every side (they never reach the frame's edge) of at most
 * `maxPx` each. Bigger holes are real gaps (the floor around a wide table), smaller ones are what lies on the surface.
 */
export function fillHoles(m: Mask, maxPx = Infinity): Mask {
  const { width: W, height: H } = m;
  const bits = m.bits.slice();
  const seen = new Uint8Array(W * H);
  const stack: number[] = [];
  for (let start = 0; start < bits.length; start++) {
    if (bits[start] || seen[start]) continue;
    const pixels: number[] = [];
    let open = false;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      pixels.push(i);
      const x = i % W;
      const y = (i - x) / W;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) open = true;
      for (const n of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
        if (n >= 0 && !bits[n] && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    if (!open && pixels.length <= maxPx) for (const i of pixels) bits[i] = 1;
  }
  return { width: W, height: H, bits };
}

/**
 * What a frame holds: the opening of a doorway, an arch or a gate, whose posts stand at the sides of its box and whose
 * lintel spans the top. Row by row below the lintel, the gap between the inner edge of the left post and that of the
 * right one; a post SAM cut short keeps its last edge down to the box's bottom, where the floor runs through.
 */
export function framedOpening(frame: Mask, box: Rect): Mask {
  const { width: W, height: H } = frame;
  const [x0, y0, x1, y1] = clampRect(box, W, H);
  const out = emptyMask(W, H);
  const third = Math.max(1, Math.floor((x1 - x0) / 3));
  const mid = [x0 + third, x1 - third];
  // The lintel: the lowest frame row in the top half of the box's middle third.
  let top = -1;
  for (let y = y0; y < y0 + (y1 - y0) / 2; y++) for (let x = mid[0]; x < mid[1]; x++) if (frame.bits[y * W + x]) top = y;
  if (top < 0) return out;
  let left = -1;
  let right = -1;
  for (let y = top + 1; y < y1; y++) {
    for (let x = mid[0] - 1; x >= x0; x--) if (frame.bits[y * W + x]) { left = x; break; }
    for (let x = mid[1]; x < x1; x++) if (frame.bits[y * W + x]) { right = x; break; }
    if (left < 0 || right < 0) continue;
    for (let x = left + 1; x < right; x++) if (!frame.bits[y * W + x]) out.bits[y * W + x] = 1;
  }
  return out;
}
