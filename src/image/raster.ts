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

/** Grows (r > 0) or shrinks (r < 0) a mask by a square of |r| px, as two separable passes. */
export function dilate(m: Mask, r: number): Mask {
  if (r === 0) return { ...m, bits: m.bits.slice() };
  const grow = r > 0;
  const k = Math.abs(r);
  const { width: W, height: H } = m;
  const pass = (src: Uint8Array, along: 'x' | 'y') => {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let v = grow ? 0 : 1;
        for (let d = -k; d <= k; d++) {
          const nx = along === 'x' ? x + d : x;
          const ny = along === 'y' ? y + d : y;
          // Outside the frame counts as empty: shrinking eats in from the edges, growing doesn't wrap.
          const s = nx < 0 || ny < 0 || nx >= W || ny >= H ? 0 : src[ny * W + nx];
          if (grow ? s : !s) { v = grow ? 1 : 0; break; }
        }
        out[y * W + x] = v;
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
