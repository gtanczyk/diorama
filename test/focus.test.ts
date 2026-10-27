import { describe, expect, it } from 'vitest';
import { focusMask, planeDepth, softness } from '../src/play/focus.ts';

describe('focus', () => {
  it('keeps the hero and what stands in front of them sharp, softens what is behind with its distance', () => {
    const focus = 500;
    expect(softness(600, focus)).toBe(0);
    expect(softness(495, focus)).toBe(0);
    const near = softness(450, focus);
    const far = softness(300, focus);
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(near);
    expect(softness(0, focus)).toBe(1);
    // The sky (no depth) is as far as it gets.
    expect(softness(-1, focus)).toBe(1);
  });

  it('looks the same wherever the hero stands: softness depends on how much farther, not on rows', () => {
    expect(softness(400, 500)).toBeCloseTo(softness(200, 250), 6);
  });

  it('makes a mask with one alpha per depth pixel', () => {
    const d = { w: 2, h: 1, rows: new Float32Array([600, 100]) };
    const m = focusMask(d, 500);
    expect([m[3], m[7]]).toEqual([0, 255]);
  });

  it('stands in for a missing depth map with the floor plane and the walls on its back edge', () => {
    const d = planeDepth({ width: 32, height: 40 }, 10, 8, [24, 24, 30, 30], 2);
    const at = (x: number, y: number) => d.rows[Math.floor(y / 2) * d.w + Math.floor(x / 2)];
    expect(at(4, 4)).toBe(0);
    // Between the horizon and the back edge stands the wall, as far as the edge.
    expect(at(4, 16)).toBe(14);
    expect(at(20, 16)).toBe(20);
    expect(at(4, 36)).toBe(27);
  });
});
