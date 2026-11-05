// A drive place (kind "drive"): the backdrop cut into depth bands that each loop sideways at their own pace,
// so the scenery streams past the car. No model calls: the bands come from the depth map derive made (else the
// rows), the gaps a nearer band leaves are filled along the row from the band's own pixels, and each band's
// ends are cross-faded so it repeats without a seam.
import sharp from 'sharp';
import { DEPTH_SCALE, DEPTH_UNIT } from '../play/shadow.ts';
import { FRAME } from './layout.ts';

/** How near a band is, as rows below the horizon at its distance: the band edges, far to near. */
const EDGES = [6, 18, 40, 80, 140, 220, 330];
/** The part of each band's ends blended into its start, so it loops. */
export const DRIVE_FADE = 160;
/** A gap wider than this along a row is not filled: the band was simply not there. */
const MAX_GAP = 420;

export type DriveBand = { png: Buffer; speed: number; top: number; bottom: number };

/**
 * The whole backdrop, its ends cross-faded so it repeats: the page draws it first, row by row at each row's
 * pace, so where a band has nothing (it slid off what stood in front) the painting still shows, never a hole.
 */
export async function driveBase(backdrop: Buffer): Promise<Buffer> {
  const { width: W, height: H } = FRAME;
  const rgb = new Uint8Array(await sharp(backdrop).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer());
  const T = W - DRIVE_FADE;
  const out = new Uint8Array(T * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < T; x++) {
    const o = (y * T + x) * 3, a = (y * W + x) * 3, e = (y * W + x + T) * 3, t = Math.min(1, x / DRIVE_FADE);
    for (let k = 0; k < 3; k++) out[o + k] = Math.round(rgb[a + k] * t + rgb[e + k] * (1 - t));
  }
  return sharp(out, { raw: { width: T, height: H, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

/**
 * The bands of a drive backdrop, far first. `speed` is how fast the band moves against the nearest road row
 * (1 there), from its middle distance: on a level road the scenery's speed on screen goes with 1 / distance,
 * that is with the rows below the horizon. Each band is `FRAME.width - DRIVE_FADE` wide and repeats.
 */
export async function driveBands(backdrop: Buffer, depth: Buffer | undefined, horizonY: number): Promise<DriveBand[]> {
  const { width: W, height: H } = FRAME;
  const rgb = new Uint8Array(await sharp(backdrop).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer());
  const rows = new Float32Array(W * H);
  if (depth) {
    const d = await sharp(depth).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const [dw, dh] = [d.info.width, d.info.height];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (Math.min(dh - 1, Math.floor(y / DEPTH_SCALE)) * dw + Math.min(dw - 1, Math.floor(x / DEPTH_SCALE))) * 3;
      rows[y * W + x] = ((d.data[i] << 8) | d.data[i + 1]) / DEPTH_UNIT;
    }
  } else {
    for (let y = 0; y < H; y++) rows.fill(Math.max(0, y - horizonY), y * W, (y + 1) * W);
  }
  const bandOf = (r: number) => { let b = 0; while (b < EDGES.length && r >= EDGES[b]) b++; return b; };
  const label = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) label[i] = bandOf(rows[i]);
  const nearest = H - horizonY;
  const T = W - DRIVE_FADE;
  const bands: DriveBand[] = [];
  for (let b = 0; b <= EDGES.length; b++) {
    let top: number = H, bottom = -1;
    const px = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      const row = y * W;
      let last = -1;
      for (let x = 0; x <= W; x++) {
        const mine = x < W && label[row + x] === b;
        if (!mine) continue;
        top = Math.min(top, y); bottom = Math.max(bottom, y);
        const o = (row + x) * 4, s = (row + x) * 3;
        px[o] = rgb[s]; px[o + 1] = rgb[s + 1]; px[o + 2] = rgb[s + 2]; px[o + 3] = 255;
        // A gap since the last pixel of this band: something nearer stands in front. Fill it from both ends,
        // but only where nothing farther shows through it (that would be this band's edge, not a gap).
        if (last >= 0 && x - last > 1 && x - last <= MAX_GAP) {
          let nearer = true;
          for (let g = last + 1; g < x; g++) if (label[row + g] < b) { nearer = false; break; }
          if (nearer) for (let g = last + 1; g < x; g++) {
            const t = (g - last) / (x - last), a = (row + last) * 3, c = (row + g) * 4;
            for (let k = 0; k < 3; k++) px[c + k] = Math.round(rgb[a + k] * (1 - t) + rgb[s + k] * t);
            px[c + 3] = 255;
          }
        }
        last = x;
      }
    }
    if (bottom < 0) continue;
    // Cross-fade the last DRIVE_FADE columns into the first ones: the band is T wide and repeats.
    const out = new Uint8Array(T * H * 4);
    for (let y = top; y <= bottom; y++) for (let x = 0; x < T; x++) {
      const o = (y * T + x) * 4, a = (y * W + x) * 4;
      if (x >= DRIVE_FADE) { for (let k = 0; k < 4; k++) out[o + k] = px[a + k]; continue; }
      const e = (y * W + x + T) * 4, t = x / DRIVE_FADE;
      const [wa, we] = [px[a + 3] * t, px[e + 3] * (1 - t)];
      const alpha = wa + we;
      if (alpha <= 0) continue;
      for (let k = 0; k < 3; k++) out[o + k] = Math.round((px[a + k] * wa + px[e + k] * we) / alpha);
      out[o + 3] = Math.round(Math.max(px[a + 3], px[e + 3]) * Math.min(1, alpha / 255 + 0.5));
    }
    const mid = b === 0 ? 2 : b === EDGES.length ? (EDGES[b - 1] + nearest) / 2 : (EDGES[b - 1] + EDGES[b]) / 2;
    const png = await sharp(out, { raw: { width: T, height: H, channels: 4 } }).extract({ left: 0, top, width: T, height: bottom - top + 1 }).png().toBuffer();
    bands.push({ png, speed: Math.round((Math.min(nearest, mid) / nearest) * 1000) / 1000, top, bottom: bottom + 1 });
  }
  return bands;
}

export { CAR } from '../play/car.ts';

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
