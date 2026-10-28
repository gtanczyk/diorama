// rig.json: a cut-out figure (parts + joints) and the walk it can do. `diorama rig` writes it; the
// runtime poses it every frame. All coordinates are in the figure's own image, facing right, y down.
// No Node imports: the browser bundles this file.
import { z } from 'zod';

const XY = z.tuple([z.number(), z.number()]);

export const PART_NAMES = ['farArm', 'farThigh', 'farShin', 'farBoot', 'nearThigh', 'nearShin', 'nearBoot', 'torso', 'nearArm'] as const;
export type PartName = (typeof PART_NAMES)[number];

export const Rig = z.object({
  size: XY,
  /** Sole row: where the feet stand. */
  ground: z.number(),
  /** Head top to sole, px. */
  height: z.number(),
  hip: XY,
  shoulder: z.object({ near: XY, far: XY }),
  leg: z.object({
    near: z.object({ knee: XY, ankle: XY }),
    far: z.object({ knee: XY, ankle: XY }),
  }),
  /** Drawn back to front; `at` is the part image's top-left in the figure. */
  parts: z.array(z.object({ name: z.enum(PART_NAMES), file: z.string(), at: XY })),
});
export type Rig = z.infer<typeof Rig>;

type P = [number, number];
/** Where each part goes this frame: rotate by `turn` about `from`, then move `from` to `to`. */
export type PartPose = { from: P; to: P; turn: number };
export type Pose = Record<PartName, PartPose>;

/** Distance the figure travels per walk cycle, as a share of its height. */
export const CYCLE = 0.55;
const STANCE = 0.6;
const LIFT = 0.06;
const ARM_SWING = 0.32;

const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
const len = (a: P) => Math.hypot(a[0], a[1]);
const angle = (a: P) => Math.atan2(a[1], a[0]);
const smooth = (u: number) => u * u * (3 - 2 * u);

/** Ankle offset from the hip (dx) and lift above the ground for one leg at phase p (0 = heel strike). */
export function footAt(p: number, step: number): { dx: number; lift: number } {
  p = ((p % 1) + 1) % 1;
  if (p < STANCE) return { dx: step / 2 - (step * p) / STANCE, lift: 0 };
  const u = (p - STANCE) / (1 - STANCE);
  return { dx: -step / 2 + step * smooth(u), lift: Math.sin(Math.PI * u) };
}

/** Knee position for a two-bone leg from hip to ankle target, knee bending forward (+x). */
export function solveKnee(hip: P, target: P, thigh: number, shin: number): { knee: P; ankle: P } {
  let d = sub(target, hip);
  const reach = len(d);
  const max = (thigh + shin) * 0.999;
  if (reach > max) d = [(d[0] * max) / reach, (d[1] * max) / reach];
  const r = Math.min(len(d), max);
  const ankle: P = [hip[0] + d[0], hip[1] + d[1]];
  // Law of cosines for the thigh's angle off the hip-ankle line.
  const cos = Math.max(-1, Math.min(1, (thigh * thigh + r * r - shin * shin) / (2 * thigh * r || 1)));
  const a = angle(d) - Math.acos(cos);
  return { knee: [hip[0] + thigh * Math.cos(a), hip[1] + thigh * Math.sin(a)], ankle };
}

/**
 * The pose at walk phase `phase` (cycles, any real), or standing when `walking` is false.
 * The near leg strikes at phase 0, the far leg half a cycle later.
 */
export function pose(rig: Rig, phase: number, walking: boolean): Pose {
  const H = rig.height;
  const step = CYCLE * STANCE * H;
  const legs = (['near', 'far'] as const).map((side) => {
    const rest = rig.leg[side];
    const thigh = len(sub(rest.knee, rig.hip));
    const shin = len(sub(rest.ankle, rest.knee));
    const ankleUp = rig.ground - rest.ankle[1];
    const foot = walking ? footAt(phase + (side === 'far' ? 0.5 : 0), step) : { dx: (side === 'near' ? 0.03 : -0.03) * H, lift: 0 };
    return { side, rest, thigh, shin, ankleUp, foot };
  });
  // The hip sinks just enough for every planted foot to reach the ground: the bob of a walk.
  let hipY = rig.hip[1];
  for (const l of legs) {
    if (l.foot.lift > 0) continue;
    const vertical = Math.sqrt(Math.max(0, (0.985 * (l.thigh + l.shin)) ** 2 - l.foot.dx ** 2));
    hipY = Math.max(hipY, rig.ground - l.ankleUp - vertical);
  }
  const hip: P = [rig.hip[0], hipY];
  const drop = hipY - rig.hip[1];
  const out = {} as Pose;
  for (const l of legs) {
    const target: P = [hip[0] + l.foot.dx, rig.ground - l.ankleUp - l.foot.lift * LIFT * H];
    const { knee, ankle } = solveKnee(hip, target, l.thigh, l.shin);
    const thighTurn = angle(sub(knee, hip)) - angle(sub(l.rest.knee, rig.hip));
    const shinTurn = angle(sub(ankle, knee)) - angle(sub(l.rest.ankle, l.rest.knee));
    const name = l.side === 'near' ? 'near' : 'far';
    out[`${name}Thigh`] = { from: rig.hip, to: hip, turn: thighTurn };
    out[`${name}Shin`] = { from: l.rest.knee, to: knee, turn: shinTurn };
    // A planted boot stays flat on the ground; a swinging one follows the shin a little.
    out[`${name}Boot`] = { from: l.rest.ankle, to: ankle, turn: l.foot.lift > 0 ? shinTurn * 0.5 : 0 };
  }
  const swing = (side: 'near' | 'far') => {
    const dx = legs.find((l) => l.side === side)!.foot.dx;
    return walking ? (ARM_SWING * dx) / (step / 2) : 0;
  };
  const lift = (p: P): P => [p[0], p[1] + drop];
  out.torso = { from: rig.hip, to: hip, turn: 0 };
  // Each arm swings against its own side's leg: near leg forward, near arm back (clockwise).
  out.nearArm = { from: rig.shoulder.near, to: lift(rig.shoulder.near), turn: swing('near') };
  out.farArm = { from: rig.shoulder.far, to: lift(rig.shoulder.far), turn: swing('far') };
  return out;
}
