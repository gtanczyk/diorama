import { describe, expect, it } from 'vitest';
import { CYCLE, footAt, pose, Rig, solveKnee } from '../src/play/rig.js';

const rig: Rig = {
  size: [200, 420],
  ground: 400,
  height: 380,
  hip: [100, 210],
  shoulder: { near: [110, 116], far: [92, 116] },
  leg: { near: { knee: [104, 294], ankle: [104, 370] }, far: { knee: [96, 294], ankle: [96, 370] } },
  parts: [],
};

describe('rig', () => {
  it('solveKnee keeps bone lengths and bends the knee forward', () => {
    const { knee, ankle } = solveKnee([0, 0], [10, 150], 84, 76);
    expect(Math.hypot(knee[0], knee[1])).toBeCloseTo(84, 5);
    expect(Math.hypot(ankle[0] - knee[0], ankle[1] - knee[1])).toBeCloseTo(76, 5);
    // The knee sits ahead of the hip-ankle line.
    expect(knee[0]).toBeGreaterThan((knee[1] / 150) * 10);
  });

  it('a planted foot slides back at walking speed', () => {
    const step = 100;
    const a = footAt(0.1, step), b = footAt(0.2, step);
    expect(a.lift).toBe(0);
    // Moving 0.1 cycle covers 0.1 * step/STANCE of ground: the foot moves back by the same.
    expect(a.dx - b.dx).toBeCloseTo((0.1 * step) / 0.6, 5);
    expect(footAt(0.8, step).lift).toBeGreaterThan(0);
  });

  it('planted boots touch the ground and stay flat', () => {
    for (let k = 0; k < 20; k++) {
      const phase = k / 20;
      const p = pose(rig, phase, true);
      for (const side of ['near', 'far'] as const) {
        if (footAt(phase + (side === 'far' ? 0.5 : 0), CYCLE * 0.6 * rig.height).lift > 0) continue;
        const boot = p[`${side}Boot`];
        expect(boot.turn).toBe(0);
        expect(boot.to[1]).toBeCloseTo(rig.leg[side].ankle[1], 3);
      }
    }
  });

  it('standing is still, walking moves the arms', () => {
    const a = pose(rig, 0, false), b = pose(rig, 0.3, false);
    expect(a).toEqual(b);
    expect(a.nearArm.turn).toBe(0);
    expect(pose(rig, 0, true).nearArm.turn).not.toBe(0);
  });
});
