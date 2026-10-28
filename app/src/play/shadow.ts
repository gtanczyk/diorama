// shadow: a person's cast shadow on the painted ground, using its depth map (geometry.depth). Every ground
// pixel becomes a 3D point; a ray from it toward the sun either crosses the person or not. The person is a
// flat card standing at the feet, turned to face the sun, carrying the figure's silhouette. So the shadow
// breaks over each step, climbs a wall in its way and drops off a quay, where the flat shear can't.
// No Node imports: the browser bundles this file.
import type { Geometry } from './geometry.ts';

/** A 1.62 m person is personPx tall: the scale's unit (PERSON_M in src/scene/scale.ts). */
const PERSON_M = 1.62;
/** depth.png's layout (DEPTH_SCALE and DEPTH_UNIT in src/scene/depthmap.ts). */
export const DEPTH_SCALE = 2;
export const DEPTH_UNIT = 16;
/** Ground within about this many metres past the feet is taken as level with them (see shadowAt). */
const CONTACT_M = 0.25;

/** The depth map as floor rows below the horizon per pixel, at 1 / DEPTH_SCALE of the frame. */
export type Depth = { w: number; h: number; rows: Float32Array };

/** Decodes depth.png's pixels (RGBA, R high byte, G low byte) into rows below the horizon. */
export function decodeDepth(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Depth {
  const rows = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) rows[i] = ((rgba[i * 4] << 8) | rgba[i * 4 + 1]) / DEPTH_UNIT;
  return { w, h, rows };
}

/** The sun for one person standing at (x, y): where they stand in 3D, and the light's way. */
export type Sun = {
  /** Camera height in metres; f is the focal length in px (any fixed value: only ratios reach the screen). */
  camH: number;
  f: number;
  hor: number;
  halfW: number;
  /** The feet: across, into the picture, up (metres). */
  feet: [number, number, number];
  /** Horizontal unit vector the light travels along, and the one across it (pointing screen right). */
  along: [number, number];
  across: [number, number];
  /** Rise of a sun ray per metre along the ground. */
  rise: number;
};

/** The camera the depth map was measured with: what pointAt needs. */
export type View = Pick<Sun, 'camH' | 'f' | 'hor' | 'halfW'>;

export function viewOf(g: Geometry): View {
  return { camH: PERSON_M / g.scale.pxPerY, f: g.frame.width, hor: g.scale.horizonY, halfW: g.frame.width / 2 };
}

/** The frame pixel a 3D point (across, into, up) is seen at: pointAt the other way. */
export function toScreen(v: View, p: [number, number, number]): [number, number] | undefined {
  if (p[1] <= 0.01) return undefined;
  const zn = p[1] / v.f;
  return [v.halfW + p[0] / zn, v.hor + (v.camH - p[2]) / zn];
}

/** Metres (across, into, up) of the depth pixel under frame pixel (x, y); undefined past the map. */
export function pointAt(d: Depth, sun: Pick<Sun, 'camH' | 'f' | 'hor' | 'halfW'>, x: number, y: number): [number, number, number] | undefined {
  const c = Math.floor(x / DEPTH_SCALE);
  const r = Math.floor(y / DEPTH_SCALE);
  if (c < 0 || r < 0 || c >= d.w || r >= d.h) return undefined;
  const rows = d.rows[r * d.w + c];
  if (rows <= 0) return undefined;
  const zn = sun.camH / rows;
  return [(x - sun.halfW) * zn, zn * sun.f, sun.camH - (y - sun.hor) * zn];
}

/**
 * The sun for a person with feet at (x, y) and px tall. light.dir is how shadows run on screen and
 * light.length how long they are per height there, as the painting shows them: both are turned into a
 * direction on the ground and a sun height by projecting the ground near the feet.
 */
export function sunFor(g: Geometry, d: Depth, light: NonNullable<Geometry['light']>, x: number, y: number, px: number): Sun | undefined {
  const hor = g.scale.horizonY;
  const base = viewOf(g);
  if (y - hor < 4) return undefined;
  // The feet: the depth just above them (the floor they stand on), averaged across a few px.
  const near = [-3, 0, 3].map((dx) => pointAt(d, base, x + dx, y - 2)).filter((p): p is [number, number, number] => !!p);
  if (!near.length) return undefined;
  const feet = [0, 1, 2].map((i) => near.reduce((s, p) => s + p[i], 0) / near.length) as [number, number, number];
  // A point on the feet's level seen at screen (sx, sy), and back.
  const drop = base.camH - feet[2];
  const ground = (sx: number, sy: number): [number, number] => {
    const zn = drop / Math.max(0.5, sy - hor);
    return [(sx - base.halfW) * zn, zn * base.f];
  };
  const screen = (gx: number, gz: number): [number, number] => {
    const zn = gz / base.f;
    return [base.halfW + gx / zn, hor + drop / zn];
  };
  const n = Math.hypot(light.dir[0], light.dir[1]) || 1;
  const [dx, dy] = [light.dir[0] / n, light.dir[1] / n];
  const at = ground(x, y);
  const step = ground(x + dx * 8, Math.max(hor + 1, y + dy * 8));
  const len = Math.hypot(step[0] - at[0], step[1] - at[1]);
  if (!(len > 0)) return undefined;
  const along: [number, number] = [(step[0] - at[0]) / len, (step[1] - at[1]) / len];
  let across: [number, number] = [-along[1], along[0]];
  if (across[0] < 0) across = [-across[0], -across[1]];
  // How far along the ground a head's shadow lands to sit length * px away on screen.
  const want = light.length * px;
  let [lo, hi] = [0, 400];
  for (let i = 0; i < 30; i++) {
    const s = (lo + hi) / 2;
    const gz = at[1] + along[1] * s;
    const [sx, sy] = gz > 0.01 ? screen(at[0] + along[0] * s, gz) : [Infinity, hor];
    if (Math.hypot(sx - x, sy - y) < want) lo = s;
    else hi = s;
  }
  const reach = (lo + hi) / 2;
  if (!(reach > 0.01)) return undefined;
  return { ...base, feet, along, across, rise: PERSON_M / reach };
}

/** The figure's silhouette (alpha only): w x h px, feet at (ox, oy), px per metre. */
export type Silhouette = { alpha: Uint8ClampedArray; w: number; h: number; ox: number; oy: number; perM: number };

/** How much of the person's shadow falls on frame pixel (x, y), 0..1. */
export function shadowAt(d: Depth, sun: Sun, sil: Silhouette, x: number, y: number): number {
  const p = pointAt(d, sun, x, y);
  if (!p) return 0;
  const [rx, rz] = [p[0] - sun.feet[0], p[1] - sun.feet[1]];
  // How far past the person this point is, the way the light goes: points before the card are lit.
  const past = rx * sun.along[0] + rz * sun.along[1];
  if (past <= 0.02) return 0;
  const side = rx * sun.across[0] + rz * sun.across[1];
  // Where on the card the ray from this point back toward the sun crosses it.
  // Close to the feet the ground counts as level with them: the depth map is soft at a ledge, and a shadow
  // must stay joined to the feet; farther out every step and drop shapes it.
  const near = Math.min(1, Math.max(0, (past - CONTACT_M) / CONTACT_M));
  const up = (p[2] - sun.feet[2]) * near * near * (3 - 2 * near) + past * sun.rise;
  if (up < 0) return 0;
  const sx = Math.round(sil.ox + side * sil.perM);
  const sy = Math.round(sil.oy - up * sil.perM);
  if (sx < 0 || sy < 0 || sx >= sil.w || sy >= sil.h) return 0;
  return sil.alpha[sy * sil.w + sx] / 255;
}

/**
 * The shadows painted things (a tent, a bench) cast from a fire or a lamp standing on the floor at frame
 * pixel `at`, its light `up` metres high and `shift` metres to the side. Worked out on the depth map: each
 * floor point looks back along its ray to the light and lies in shadow where the ray passes behind a
 * caster's pixels (owner, at the depth map's size), within `thick` metres of the surface seen there. Every
 * `cell` depth pixels one value 0..1, fading out `reach` metres from the light like the light itself.
 */
export function thingShadows(
  d: Depth,
  g: Geometry,
  owner: Uint8Array,
  at: [number, number],
  { up, shift = 0, cell = 2, reach = 4 * PERSON_M, thick = 1.2 }: { up: number; shift?: number; cell?: number; reach?: number; thick?: number },
): { w: number; h: number; cell: number; alpha: Float32Array } {
  const v = viewOf(g);
  const S = DEPTH_SCALE;
  const [w, h] = [Math.ceil(d.w / cell), Math.ceil(d.h / cell)];
  const alpha = new Float32Array(w * h);
  // The light on the floor plane under it, raised.
  const zn = v.camH / Math.max(1, at[1] - v.hor);
  const L: [number, number, number] = [(at[0] - v.halfW) * zn + shift, zn * v.f, up];
  const Ls = toScreen(v, L);
  if (!Ls) return { w, h, cell, alpha };
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const [fx, fy] = [(c * cell + cell / 2) * S, (r * cell + cell / 2) * S];
    const dc = Math.floor(fx / S);
    const dr = Math.floor(fy / S);
    // A caster's own pixels are drawn over its shadow anyway.
    if (dr >= d.h || dc >= d.w || owner[dr * d.w + dc]) continue;
    const p = pointAt(d, v, fx, fy);
    if (!p || p[2] > up - 0.05) continue;
    const dist = Math.hypot(L[0] - p[0], L[1] - p[1]);
    if (dist >= reach || dist < 0.1) continue;
    const n = Math.min(64, Math.max(6, Math.ceil(Math.hypot(Ls[0] - fx, Ls[1] - fy) / (1.5 * S))));
    for (let k = 1; k < n; k++) {
      const t = k / n;
      // Not the floor point's own surface: a few cm along before anything counts.
      if (t * dist < 0.08) continue;
      const q: [number, number, number] = [p[0] + (L[0] - p[0]) * t, p[1] + (L[1] - p[1]) * t, p[2] + (L[2] - p[2]) * t];
      const s = toScreen(v, q);
      if (!s) continue;
      const [qc, qr] = [Math.floor(s[0] / S), Math.floor(s[1] / S)];
      if (qc < 0 || qr < 0 || qc >= d.w || qr >= d.h || !owner[qr * d.w + qc]) continue;
      const surf = pointAt(d, v, s[0], s[1]);
      if (surf && q[1] > surf[1] - 0.05 && q[1] < surf[1] + thick) {
        alpha[r * w + c] = 1 - dist / reach;
        break;
      }
    }
  }
  return { w, h, cell, alpha };
}
