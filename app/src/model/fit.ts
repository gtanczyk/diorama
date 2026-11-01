// Where each painted view of the hero lands on the model: a scale and offset per image axis, found by
// laying the model's silhouette over the figure in the painting. The runtime projects with the same
// numbers, so the paint sits on the coat while it walks.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { normalise, readShape, type Shape } from './glb.ts';

/** Which way each view looks at the hero (who faces +z): the model axis that runs left to right in the picture, and its sign. */
export const VIEWS = {
  front: { axis: 0, sign: 1 },
  back: { axis: 0, sign: -1 },
  left: { axis: 2, sign: -1 }, // facing the picture's left: the camera stands at +x
  right: { axis: 2, sign: 1 },
} as const;
export type ViewName = keyof typeof VIEWS;

/**
 * u = a * axis + b, v = c * y + d, in image units (0..1, v from the top), model in hero units. bands: [a, b] for
 * each of BANDS slices of the height from the feet up, fitted on that slice alone (the runtime blends them
 * between slice centres). Muse paints a profile's head, body and legs each a little off from the model, and a
 * fit of the whole silhouette leaves the profile's face on the model's cheek, a second face beside the front's.
 */
export type ViewFit = { u: [number, number]; v: [number, number]; iou: number; bands?: [number, number][] };

export const BANDS = 20;

const R = 160;

/** How wide the silhouette grid is across, in heights: 1 for a person, more for a creature wider than it is tall (a cat side on). */
function across(shape: Shape): number {
  let most = 0;
  for (let i = 0; i < shape.positions.length; i += 3) most = Math.max(most, Math.abs(shape.positions[i]), Math.abs(shape.positions[i + 2]));
  return Math.max(1, 2 * most + 0.04);
}

function silhouette(shape: Shape, view: ViewName, W: number): Uint8Array {
  const { axis, sign } = VIEWS[view];
  const p = shape.positions;
  const px = (i: number) => (sign * p[i * 3 + axis] / W + 0.5) * R;
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
  // A pale shirt is close to the grey background, so the cut leaves holes in the figure. The background is
  // what joins the border; everything else is figure.
  const outside = new Uint8Array(R * R);
  const queue: number[] = [];
  for (let i = 0; i < R; i++) for (const at of [i, (R - 1) * R + i, i * R, i * R + R - 1]) if (!mask[at] && !outside[at]) { outside[at] = 1; queue.push(at); }
  while (queue.length) {
    const at = queue.pop()!;
    const [x, y] = [at % R, Math.floor(at / R)];
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      const next = ny * R + nx;
      if (nx >= 0 && nx < R && ny >= 0 && ny < R && !mask[next] && !outside[next]) { outside[next] = 1; queue.push(next); }
    }
  }
  for (let i = 0; i < R * R; i++) mask[i] = outside[i] ? 0 : 1;
  return { mask, aspect: (meta.height ?? 1) / (meta.width ?? 1) };
}

/**
 * How well the painted figure lies over the model's silhouette. `bare` weighs model left unpainted against paint
 * off the model: above 1, a fit that covers the model wins, since a bare edge is painted from another view
 * (its nose, its mouth) while paint off the model shows nowhere.
 */
function iou(sil: Uint8Array, mask: Uint8Array, a: number, b: number, c: number, d: number, rows: [number, number] = [0, R], bare = 1, W = 1): number {
  let both = 0;
  let silOnly = 0;
  let maskOnly = 0;
  for (let y = rows[0]; y < rows[1]; y++) {
    const v = c * (1 - (y + 0.5) / R) + d;
    const my = Math.floor(v * R);
    for (let x = 0; x < R; x++) {
      const u = a * W * ((x + 0.5) / R - 0.5) + b;
      const mx = Math.floor(u * R);
      const m = mx >= 0 && mx < R && my >= 0 && my < R ? mask[my * R + mx] : 0;
      const s = sil[y * R + x];
      both += s & m;
      silOnly += s & (1 - m);
      maskOnly += m & (1 - s);
    }
  }
  return both ? both / (both + bare * silOnly + maskOnly) : 0;
}

export async function fitView(shape: Shape, view: ViewName, png: Buffer): Promise<ViewFit> {
  const W = across(shape);
  const sil = silhouette(shape, view, W);
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
        const score = iou(sil, mask, a, uc + db, c, d, [0, R], 1, W);
        if (score > best.iou) best = { u: [a, uc + db], v: [c, d], iou: score };
      }
    }
  }
  return { ...best, iou: Math.round(best.iou * 1000) / 1000, bands: fitBands(sil, mask, best, W) };
}

/** Each slice's own scale and offset across, near the whole fit, then smoothed with its neighbours. */
function fitBands(sil: Uint8Array, mask: Uint8Array, whole: ViewFit, W: number): [number, number][] {
  const [a0, b0] = whole.u;
  const [c, d] = whole.v;
  const raw = [...Array(BANDS).keys()].map((k): [number, number] => {
    // Model heights k/BANDS..(k+1)/BANDS are silhouette rows from (1 - (k+1)/BANDS) R down.
    const rows: [number, number] = [Math.max(0, Math.floor((1 - (k + 1) / BANDS) * R)), Math.min(R, Math.ceil((1 - k / BANDS) * R))];
    let area = 0;
    for (let y = rows[0]; y < rows[1]; y++) for (let x = 0; x < R; x++) area += sil[y * R + x];
    if (area < 20) return [a0, b0];
    let best: [number, number] = [a0, b0];
    let top = -Infinity;
    for (let ka = 0.85; ka <= 1.1501; ka += 0.015) {
      for (let db = -0.08; db <= 0.0801; db += 0.004) {
        // A slight pull to the whole fit, so a slice with little to go on stays with its neighbours.
        const score = iou(sil, mask, a0 * ka, b0 + db, c, d, rows, 2, W) - 0.05 * (Math.abs(ka - 1) + 4 * Math.abs(db));
        if (score > top) [top, best] = [score, [a0 * ka, b0 + db]];
      }
    }
    return best;
  });
  return raw.map((_, k) => {
    const near = [raw[Math.max(0, k - 1)], raw[k], raw[k], raw[Math.min(BANDS - 1, k + 1)]];
    return [near.reduce((s, n) => s + n[0], 0) / 4, near.reduce((s, n) => s + n[1], 0) / 4];
  });
}

/** Fits every view of a model; model.json's `views`. */
export async function fitViews(glb: Buffer, views: Record<ViewName, Buffer>): Promise<Record<ViewName, { image: string } & ViewFit>> {
  const shape = normalise(readShape(glb, true));
  const fits = {} as Record<ViewName, { image: string } & ViewFit>;
  for (const v of Object.keys(VIEWS) as ViewName[]) fits[v] = { image: `${v}.png`, ...(await fitView(shape, v, views[v])) };
  return fits;
}

/** A model fitted before views were fitted slice by slice is fitted again (no Muse, no TRELLIS: its own files). */
export async function refitIfOld(modelDir: string, always = false): Promise<boolean> {
  const file = path.join(modelDir, 'model.json');
  const info = JSON.parse(fs.readFileSync(file, 'utf8')) as { glb: string; views: Record<ViewName, { image: string } & ViewFit> };
  if (!always && Object.values(info.views).every((v) => v.bands?.length === BANDS)) return false;
  const views = Object.fromEntries(Object.entries(info.views).map(([k, v]) => [k, fs.readFileSync(path.join(modelDir, v.image))])) as Record<ViewName, Buffer>;
  info.views = await fitViews(fs.readFileSync(path.join(modelDir, info.glb)), views);
  fs.writeFileSync(file, JSON.stringify(info, null, 2));
  return true;
}
