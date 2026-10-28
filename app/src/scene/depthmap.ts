// depthmap: how far every pixel of the painting is, so a person's shadow can follow the steps, climb a wall
// and drop off a quay instead of lying flat like a sticker. Depth Anything V2 Small (ONNX, on the CPU, ~1 s)
// gives relative depth; it is pinned to the place's own floor, whose distance we already know from the
// horizon: on the walk cells the floor is one plane, so its disparity grows with y - horizonY. A robust line
// through the walk cells turns the model's numbers into "the floor row at the same distance" for every pixel.
// The runtime unprojects that to 3D (camera height from scale.pxPerY) and casts shadows on it.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { Geometry } from '../play/geometry.ts';
// depth.png is half the frame (the model sees ~518 px across, more pixels would only store blur) and holds
// rows below the horizon * DEPTH_UNIT as R (high byte) and G (low byte).
import { DEPTH_SCALE, DEPTH_UNIT } from '../play/shadow.ts';
import { FRAME } from './layout.ts';

const MODEL_URL = 'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model_quantized.onnx';
const MODEL_FILE = path.resolve('.diorama/models/depth-anything-v2-small-q8.onnx');
/** The model's input: multiples of its 14 px patches, at the frame's aspect. */
const IN_W = 518;
const IN_H = 392;
/** A fit that explains fewer walk cells than this is not the floor: no depth map, shadows stay flat. */
const MIN_INLIERS = 0.35;

export type DepthMap = { png: Buffer; inliers: number; cells: number };

async function modelPath(): Promise<string> {
  if (fs.existsSync(MODEL_FILE)) return MODEL_FILE;
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`depth model: HTTP ${res.status} from ${MODEL_URL}`);
  fs.mkdirSync(path.dirname(MODEL_FILE), { recursive: true });
  fs.writeFileSync(`${MODEL_FILE}.part`, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(`${MODEL_FILE}.part`, MODEL_FILE);
  return MODEL_FILE;
}

/** Relative inverse depth (bigger = nearer) at the model's resolution. */
async function disparity(painting: Buffer): Promise<Float32Array> {
  const ort = await import('onnxruntime-node');
  const raw = await sharp(painting).resize(IN_W, IN_H, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  const n = IN_W * IN_H;
  const input = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) input[c * n + i] = (raw[i * 3 + c] / 255 - mean[c]) / std[c];
  const session = await ort.InferenceSession.create(await modelPath());
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, IN_H, IN_W]) });
  return out[session.outputNames[0]].data as Float32Array;
}

/** Bilinear sample of the model's grid at a frame pixel. */
function sampleAt(d: Float32Array, x: number, y: number): number {
  const fx = Math.min(IN_W - 1.001, Math.max(0, ((x + 0.5) * IN_W) / FRAME.width - 0.5));
  const fy = Math.min(IN_H - 1.001, Math.max(0, ((y + 0.5) * IN_H) / FRAME.height - 0.5));
  const [x0, y0] = [Math.floor(fx), Math.floor(fy)];
  const [u, v] = [fx - x0, fy - y0];
  const at = (xx: number, yy: number) => d[yy * IN_W + xx];
  return (at(x0, y0) * (1 - u) + at(x0 + 1, y0) * u) * (1 - v) + (at(x0, y0 + 1) * (1 - u) + at(x0 + 1, y0 + 1) * u) * v;
}

/**
 * The line d = a * (y - horizonY) + b that most walk cells agree with (RANSAC, then least squares on its
 * inliers). Cells on raised floors or stairs disagree and are left out, so the main floor sets the scale.
 */
export function fitFloor(samples: Array<[number, number]>, seed = 1): { a: number; b: number; inliers: number } | undefined {
  if (samples.length < 8) return undefined;
  let rnd = seed;
  const random = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  const ds = samples.map((s) => s[1]).sort((p, q) => p - q);
  const tol = 0.05 * (ds[Math.floor(ds.length * 0.95)] - ds[Math.floor(ds.length * 0.05)] || 1);
  let best: number[] = [];
  for (let it = 0; it < 400; it++) {
    const [p, q] = [samples[Math.floor(random() * samples.length)], samples[Math.floor(random() * samples.length)]];
    if (Math.abs(p[0] - q[0]) < 40) continue;
    const a = (q[1] - p[1]) / (q[0] - p[0]);
    if (a <= 0) continue;
    const b = p[1] - a * p[0];
    const inl = samples.flatMap((s, i) => (Math.abs(s[1] - (a * s[0] + b)) < tol ? [i] : []));
    if (inl.length > best.length) best = inl;
  }
  if (best.length < 2) return undefined;
  let [sx, sy, sxx, sxy] = [0, 0, 0, 0];
  for (const i of best) {
    const [x, y] = samples[i];
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const n = best.length;
  const a = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const b = (sy - a * sx) / n;
  return a > 0 ? { a, b, inliers: n / samples.length } : undefined;
}

/** depth.png for a derived place, or undefined (with the reason) when the model's depth doesn't fit its floor. */
export async function depthMap(painting: Buffer, g: Geometry): Promise<DepthMap | { reason: string }> {
  const d = await disparity(painting);
  const hor = g.scale.horizonY;
  const samples: Array<[number, number]> = [];
  g.walk.forEach((row, r) => [...row].forEach((ch, c) => {
    const [x, y] = [(c + 0.5) * g.cell, (r + 0.5) * g.cell];
    if (ch === '#' && y > hor + 8) samples.push([y - hor, sampleAt(d, x, y)]);
  }));
  const fit = fitFloor(samples);
  if (!fit || fit.inliers < MIN_INLIERS) return { reason: `depth fits the floor on ${Math.round((fit?.inliers ?? 0) * 100)}% of walk cells` };
  const [w, h] = [FRAME.width / DEPTH_SCALE, FRAME.height / DEPTH_SCALE];
  const rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    // The floor row (below the horizon) at this pixel's distance; the sky and the far bank sit just under it.
    const rows = (sampleAt(d, x * DEPTH_SCALE + 0.5, y * DEPTH_SCALE + 0.5) - fit.b) / fit.a;
    const v = Math.round(Math.min(65535, Math.max(1, rows * DEPTH_UNIT)));
    rgb[(y * w + x) * 3] = v >> 8;
    rgb[(y * w + x) * 3 + 1] = v & 255;
  }
  const png = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 9 }).toBuffer();
  return { png, inliers: fit.inliers, cells: samples.length };
}
