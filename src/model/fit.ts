// Where each painted view of the hero lands on the model: a scale and offset per image axis, found by
// laying the model's silhouette over the figure in the painting. The runtime projects with the same
// numbers, so the paint sits on the coat while it walks.
import sharp from 'sharp';
import type { Shape } from './glb.ts';

/** Which way each view looks at the hero (who faces +z): the model axis that runs left to right in the picture, and its sign. */
export const VIEWS = {
  front: { axis: 0, sign: 1 },
  back: { axis: 0, sign: -1 },
  left: { axis: 2, sign: -1 }, // facing the picture's left: the camera stands at +x
  right: { axis: 2, sign: 1 },
} as const;
export type ViewName = keyof typeof VIEWS;

/** u = a * axis + b, v = c * y + d, in image units (0..1, v from the top), model in hero units. */
export type ViewFit = { u: [number, number]; v: [number, number]; iou: number };

const R = 160;

function silhouette(shape: Shape, view: ViewName): Uint8Array {
  const { axis, sign } = VIEWS[view];
  const p = shape.positions;
  const px = (i: number) => (sign * p[i * 3 + axis] + 0.5) * R;
  const py = (i: number) => (1 - p[i * 3 + 1]) * R;
  const out = new Uint8Array(R * R);
  const t = shape.triangles;
  for (let k = 0; k < t.length; k += 3) {
    const [x0, y0, x1, y1, x2, y2] = [px(t[k]), py(t[k]), px(t[k + 1]), py(t[k + 1]), px(t[k + 2]), py(t[k + 2])];
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-9) continue;
    for (let y = Math.max(0, Math.floor(Math.min(y0, y1, y2))); y <= Math.min(R - 1, Math.ceil(Math.max(y0, y1, y2))); y++) {
      for (let x = Math.max(0, Math.floor(Math.min(x0, x1, x2))); x <= Math.min(R - 1, Math.ceil(Math.max(x0, x1, x2))); x++) {
        const [cx, cy] = [x + 0.5, y + 0.5];
        const w0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) / area;
        const w1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) / area;
        if (w0 >= 0 && w1 >= 0 && w0 + w1 <= 1) out[y * R + x] = 1;
      }
    }
  }
  return out;
}

/** The figure in a painted view on its flat background, at R x R, plus the image's aspect (height / width). */
async function figureMask(png: Buffer): Promise<{ mask: Uint8Array; aspect: number }> {
  const meta = await sharp(png).metadata();
  const { data } = await sharp(png).removeAlpha().resize(R, R, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const border: number[][] = [];
  for (let i = 0; i < R; i++) for (const [x, y] of [[i, 0], [i, R - 1], [0, i], [R - 1, i]]) border.push([...data.subarray((y * R + x) * 3, (y * R + x) * 3 + 3)]);
  const bg = [0, 1, 2].map((c) => border.map((b) => b[c]).sort((a, b) => a - b)[border.length >> 1]);
  const mask = new Uint8Array(R * R);
  for (let i = 0; i < R * R; i++) mask[i] = Math.abs(data[i * 3] - bg[0]) + Math.abs(data[i * 3 + 1] - bg[1]) + Math.abs(data[i * 3 + 2] - bg[2]) > 40 ? 1 : 0;
  return { mask, aspect: (meta.height ?? 1) / (meta.width ?? 1) };
}

function iou(sil: Uint8Array, mask: Uint8Array, a: number, b: number, c: number, d: number): number {
  let both = 0;
  let either = 0;
  for (let y = 0; y < R; y++) {
    const v = c * (1 - (y + 0.5) / R) + d;
    const my = Math.floor(v * R);
    for (let x = 0; x < R; x++) {
      const u = a * ((x + 0.5) / R - 0.5) + b;
      const mx = Math.floor(u * R);
      const m = mx >= 0 && mx < R && my >= 0 && my < R ? mask[my * R + mx] : 0;
      const s = sil[y * R + x];
      both += s & m;
      either += s | m;
    }
  }
  return either ? both / either : 0;
}

export async function fitView(shape: Shape, view: ViewName, png: Buffer): Promise<ViewFit> {
  const sil = silhouette(shape, view);
  const { mask, aspect } = await figureMask(png);
  let top = R;
  let bottom = -1;
  let sumX = 0;
  let n = 0;
  for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) if (mask[y * R + x]) { top = Math.min(top, y); bottom = Math.max(bottom, y); sumX += x; n++; }
  if (!n) throw new Error(`${view}: no figure found on the background`);
  const [vt, vb, uc] = [top / R, (bottom + 1) / R, (sumX / n + 0.5) / R];
  let best: ViewFit = { u: [0, 0], v: [0, 0], iou: -1 };
  for (let ks = 0.9; ks <= 1.1001; ks += 0.01) {
    const c = -(vb - vt) * ks;
    const d = vb;
    for (let kx = 0.8; kx <= 1.2501; kx += 0.015) {
      const a = (vb - vt) * ks * aspect * kx;
      for (let db = -0.04; db <= 0.0401; db += 0.005) {
        const score = iou(sil, mask, a, uc + db, c, d);
        if (score > best.iou) best = { u: [a, uc + db], v: [c, d], iou: score };
      }
    }
  }
  return { ...best, iou: Math.round(best.iou * 1000) / 1000 };
}
