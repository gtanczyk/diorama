// focus: the camera focuses on the hero, so what stands behind them goes soft and a little paler with its
// distance, like a real diorama shot close up. It is what tells a figure from the painted thing at their back:
// both are painted equally sharp, and only the depth map knows which is farther.
// No Node imports: the browser bundles this file.
import type { Depth } from './shadow.ts';

/** Frame px of blur at full defocus (the sky, the far sea when the hero is near). */
export const FOCUS_BLUR = 1.4;
/** Behind the focus by this share of its depth, a thing is fully soft (five times as far as the hero). */
const FULL = 0.8;
/** The first few % behind the feet stay sharp: the floor the hero stands on. */
const SHARP = 0.03;

/**
 * How soft each depth pixel is, 0..1, with the focus on a floor row `focus` px below the horizon. Depth rows
 * are inverse distance, so the defocus of a pixel grows with how far its rows fall short of the focus (a thin
 * lens's blur circle is linear in 1/z - 1/z_focus); scaled by the focus itself, so the look is the same whether
 * the hero stands near or far. Nearer than the focus stays sharp: those things are drawn over the hero anyway.
 * A pixel with no depth (rows 0, the sky) counts as far.
 */
export function softness(rows: number, focus: number): number {
  if (focus <= 0) return 0;
  const t = (focus * (1 - SHARP) - Math.max(0, rows)) / (focus * FULL);
  if (t <= 0) return 0;
  // Linear: just behind the hero it barely shows, only the far view goes really soft.
  return Math.min(1, t);
}

/** The softness of every depth pixel as an alpha mask (RGBA, white), for compositing the soft frame. */
export function focusMask(d: Depth, focus: number, out: Uint8ClampedArray = new Uint8ClampedArray(d.w * d.h * 4)): Uint8ClampedArray {
  for (let i = 0; i < d.w * d.h; i++) {
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 255;
    out[i * 4 + 3] = Math.round(255 * softness(d.rows[i], focus));
  }
  return out;
}

/**
 * A stand-in depth map for a place without depth.png (no fit, or built before it existed): the floor plane
 * below the horizon, and above each column's back edge whatever stands there (a wall, a railing) as far as
 * that edge. Above the horizon is the far view. Cards stamp their own floor row over it (see the runtime).
 */
export function planeDepth(frame: { width: number; height: number }, horizonY: number, cell: number, edge: ArrayLike<number>, scale: number): Depth {
  const [w, h] = [Math.ceil(frame.width / scale), Math.ceil(frame.height / scale)];
  const rows = new Float32Array(w * h);
  for (let r = 0; r < h; r++) {
    const y = r * scale + scale / 2;
    for (let c = 0; c < w; c++) {
      const e = edge[Math.min(edge.length - 1, Math.floor((c * scale) / cell))] ?? horizonY;
      rows[r * w + c] = y <= horizonY ? 0 : Math.max(0, (y < e ? e : y) - horizonY);
    }
  }
  return { w, h, rows };
}

/** The separation shade: its darkness, blur and push away from the light, per person height. */
export const SEPARATE_ALPHA = 0.5;
export const SEPARATE_BLUR = 0.05;
export const SEPARATE_SHIFT = 0.12;
/** Things up to this share of the feet's depth farther still take the shade, fading to none there. */
const BEHIND = 0.3;

/**
 * How much of a person's separation shade lands on a depth pixel, for feet `feet` rows below the horizon:
 * full on what stands right at or just behind them (the plinth at their back, the floor at their heels),
 * fading over BEHIND of their depth, none on what is nearer (it is drawn over them) or has no depth (the sky).
 */
export function behindWeight(rows: number, feet: number): number {
  if (rows <= 0 || feet <= 0 || rows > feet * 1.03) return 0;
  const t = (feet - rows) / (feet * BEHIND);
  return Math.max(0, 1 - Math.max(0, t));
}
