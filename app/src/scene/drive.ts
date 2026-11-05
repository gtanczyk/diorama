// A drive place (kind "drive"): a chase view along a straight road, which the page sets streaming toward the
// camera. The backdrop is split in two by the depth map: the far view (sky, skyline) stays put, and everything
// nearer (the road, the roadside) is drawn growing out of the vanishing point, so what stands beside the road
// comes nearer, grows and slides off the sides. No model calls.
import sharp from 'sharp';
import { DEPTH_SCALE, DEPTH_UNIT } from '../play/shadow.ts';
import { FRAME } from './layout.ts';

export { CAR } from '../play/car.ts';

/** Nearer than this (rows below the horizon at its distance) a pixel streams toward the camera; farther it stays. */
const NEAR_ROWS = 9;

export type DriveLayers = { near: Buffer; far: Buffer; vp: [number, number] };

/**
 * The near layer (the backdrop where it streams, transparent over the far view) and the far layer (the backdrop
 * with what stood up near the road above the horizon filled from the sky above it, for when the near layer has
 * grown past it). `vp`: the vanishing point, the top of the road on the horizon.
 */
export async function driveLayers(backdrop: Buffer, depth: Buffer | undefined, horizonY: number, roadTopX: number): Promise<DriveLayers> {
  const { width: W, height: H } = FRAME;
  const rgb = new Uint8Array(await sharp(backdrop).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer());
  const near = new Uint8Array(W * H);
  const d = depth ? await sharp(depth).removeAlpha().raw().toBuffer({ resolveWithObject: true }) : undefined;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let rows = y - horizonY;
    if (d) {
      const i = (Math.min(d.info.height - 1, Math.floor(y / DEPTH_SCALE)) * d.info.width + Math.min(d.info.width - 1, Math.floor(x / DEPTH_SCALE))) * 3;
      rows = Math.max(rows, ((d.data[i] << 8) | d.data[i + 1]) / DEPTH_UNIT);
    }
    near[y * W + x] = y >= horizonY || rows >= NEAR_ROWS ? 255 : 0;
  }
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = rgb[i * 3]; rgba[i * 4 + 1] = rgb[i * 3 + 1]; rgba[i * 4 + 2] = rgb[i * 3 + 2]; rgba[i * 4 + 3] = near[i];
  }
  // A soft edge, so a palm's crown does not come off its sky as a cut-out.
  const alpha = await sharp(Buffer.from(near), { raw: { width: W, height: H, channels: 1 } }).blur(1.2).extractChannel(0).raw().toBuffer();
  for (let i = 0; i < W * H; i++) rgba[i * 4 + 3] = alpha[i];
  // The far view: down each column, a near pixel above the horizon takes the far colour above it.
  const far = Uint8Array.from(rgb);
  for (let x = 0; x < W; x++) {
    let last = -1;
    for (let y = 0; y < Math.min(H, Math.ceil(horizonY) + 4); y++) {
      if (!near[y * W + x]) { last = y; continue; }
      if (last < 0) continue;
      for (let k = 0; k < 3; k++) far[(y * W + x) * 3 + k] = far[(last * W + x) * 3 + k];
    }
  }
  return {
    near: await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer(),
    far: await sharp(far, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 90 }).toBuffer(),
    vp: [Math.round(roadTopX), Math.round(horizonY)],
  };
}

/**
 * The road where the car stood, filled along each row from the road left and right of it. The painted shade under
 * the car (and what Muse left there) would slide away from the car; the road is the same along a row, so a row's
 * two ends say what is under it.
 */
export async function clearUnderCar(backdrop: Buffer, box: [number, number, number, number]): Promise<Buffer> {
  const { width: W, height: H } = FRAME;
  const rgb = new Uint8Array(await sharp(backdrop).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer());
  const [x0, y0, x1, y1] = box;
  const pad = Math.round((x1 - x0) * 0.08);
  const [a, b] = [Math.max(0, Math.round(x0) - pad), Math.min(W - 1, Math.round(x1) + pad)];
  // From the wheels' height down, and a little past the car's foot, where its shade lies.
  const [top, bottom] = [Math.round(y0 + (y1 - y0) * 0.3), Math.min(H, Math.round(y1 + (y1 - y0) * 0.12))];
  for (let y = top; y < bottom; y++) {
    // A few pixels outside the box on each side, averaged, so one stray pixel does not streak the row.
    const side = (x: number, dir: number) => [0, 1, 2].map((k) => {
      let sum = 0;
      for (let i = 0; i < 6; i++) sum += rgb[(y * W + Math.max(0, Math.min(W - 1, x + dir * i))) * 3 + k];
      return sum / 6;
    });
    const [l, r] = [side(a, -1), side(b, 1)];
    for (let x = a; x <= b; x++) {
      const t = (x - a) / Math.max(1, b - a);
      for (let k = 0; k < 3; k++) rgb[(y * W + x) * 3 + k] = Math.round(l[k] * (1 - t) + r[k] * t);
    }
  }
  return sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}
