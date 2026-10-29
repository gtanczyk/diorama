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
  /**
   * The walk drawn ahead as a sheet (src/scene/warp.ts): `frames` cells of one cycle, then the standing figure, each
   * `cell` px (the rig's size times `scale`). Present, the parts are not used.
   */
  sheet: z.object({ file: z.string(), cols: z.number(), rows: z.number(), frames: z.number(), cell: XY, scale: z.number() }).optional(),
  /** The walk measured when it was made (src/scene/rig-check.ts): not ok, the figure slides as one piece instead. */
  check: z.object({ ok: z.boolean(), holes: z.number(), loose: z.number(), why: z.string().optional() }).optional(),
});
export type Rig = z.infer<typeof Rig>;

type P = [number, number];
/** Where each part goes this frame: rotate by `turn` about `from`, then move `from` to `to`. */
export type PartPose = { from: P; to: P; turn: number };
export type Pose = Record<PartName, PartPose>;

/** The sheet cell for walk phase `phase`, or the standing cell. */
export function sheetCell(sheet: NonNullable<Rig['sheet']>, phase: number, walking: boolean): number {
  return walking ? Math.floor((((phase % 1) + 1) % 1) * sheet.frames) % sheet.frames : sheet.frames;
}

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

const THIGH_SWING = 0.3;
const KNEE_BEND = 0.55;
const ARM_TURN = 0.22;

const turnAbout = (p: P, about: P, a: number): P => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const d = sub(p, about);
  return [about[0] + c * d[0] - s * d[1], about[1] + s * d[0] + c * d[1]];
};

/**
 * A walk told in angles from the painted stance, not reached by solving for foot targets: each thigh swings a
 * little either side of where it was painted and the knee bends while the foot is up. Whatever the painting's
 * stance (feet wide apart, boots up to the knee), no limb turns further than THIGH_SWING + KNEE_BEND, so a figure
 * warped as one mesh (src/scene/warp.ts) bends without folding over itself. The planted foot stays on the ground.
 */
export function swingPose(rig: Rig, phase: number): Pose {
  const out = {} as Pose;
  const legs = (['near', 'far'] as const).map((side) => {
    const p = (((phase + (side === 'far' ? 0.5 : 0)) % 1) + 1) % 1;
    // Forward is anticlockwise for a figure facing right (y down): the thigh comes forward for heel strike at 0.
    const thigh = -THIGH_SWING * Math.cos(2 * Math.PI * p);
    const lifted = p > 0.5 ? Math.sin(Math.PI * (p - 0.5) / 0.5) : 0;
    const shin = thigh + KNEE_BEND * lifted;
    const rest = rig.leg[side];
    const knee = turnAbout(rest.knee, rig.hip, thigh);
    const ankleAt: P = [knee[0] + Math.cos(shin) * (rest.ankle[0] - rest.knee[0]) - Math.sin(shin) * (rest.ankle[1] - rest.knee[1]), knee[1] + Math.sin(shin) * (rest.ankle[0] - rest.knee[0]) + Math.cos(shin) * (rest.ankle[1] - rest.knee[1])];
    return { side, thigh, shin, knee, ankle: ankleAt, lifted, rest };
  });
  // The body sinks so the planted foot (the one not lifted, or the lower) stays on the ground.
  const planted = legs.reduce((a, b) => (a.lifted < b.lifted || (a.lifted === b.lifted && a.ankle[1] > b.ankle[1]) ? a : b));
  const drop = planted.rest.ankle[1] - planted.ankle[1];
  const down = (q: P): P => [q[0], q[1] + drop];
  const hip = down(rig.hip);
  for (const l of legs) {
    out[`${l.side}Thigh`] = { from: rig.hip, to: hip, turn: l.thigh };
    out[`${l.side}Shin`] = { from: l.rest.knee, to: down(l.knee), turn: l.shin };
    // A planted boot stays flat; a lifted one tips with the shin a little.
    out[`${l.side}Boot`] = { from: l.rest.ankle, to: down(l.ankle), turn: l.lifted * l.shin * 0.5 };
  }
  out.torso = { from: rig.hip, to: hip, turn: 0 };
  const arm = ARM_TURN * Math.cos(2 * Math.PI * phase);
  out.nearArm = { from: rig.shoulder.near, to: down(rig.shoulder.near), turn: arm };
  out.farArm = { from: rig.shoulder.far, to: down(rig.shoulder.far), turn: -arm };
  return out;
}
