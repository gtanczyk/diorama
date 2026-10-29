import { describe, expect, it } from 'vitest';
import { badModel, readShape, type Shape } from '../src/model/glb.ts';
import { boxGlb } from './fixtures/model-box.ts';

/** A box of vertices, width x height x depth, as a Shape (triangles do not matter to badModel). */
function box(w: number, h: number, d: number): Shape {
  const p: number[] = [];
  for (let x = 0; x < 10; x++) for (let y = 0; y < 10; y++) for (let z = 0; z < 10; z++) p.push((x / 9 - 0.5) * w, y / 9 * h, (z / 9 - 0.5) * d);
  return { positions: new Float32Array(p), triangles: new Uint32Array() };
}

describe('model gate', () => {
  it('turns down a flat card TRELLIS made of a flat drawing', () => {
    expect(badModel(box(0.5, 1.6, 0.04))).toMatch(/^flat/);
  });
  it('keeps a body as deep as a person or a chibi', () => {
    expect(badModel(box(0.45, 1.6, 0.3))).toBeNull();
    expect(badModel(box(0.8, 1.0, 0.25))).toBeNull();
  });
  it('rejects the horizontal sheet proportions that caused the dragon failure', () => {
    expect(badModel(readShape(boxGlb([1, 0.043, 1])))).toMatch(/^flat/);
  });
  it('rejects a thin card tilted around multiple axes', () => {
    const s = box(1, 0.02, 1);
    for (let i = 0; i < s.positions.length; i += 3) {
      const [x, y, z] = s.positions.slice(i, i + 3);
      const yy = y * Math.cos(0.7) - z * Math.sin(0.7), zz = y * Math.sin(0.7) + z * Math.cos(0.7);
      s.positions.set([x * Math.cos(0.6) - yy * Math.sin(0.6), x * Math.sin(0.6) + yy * Math.cos(0.6), zz], i);
    }
    expect(badModel(s)).toMatch(/^flat/);
  });
  it('keeps a long creature and accepts valid meshes regardless of scale and offset', () => {
    expect(badModel(box(8, 0.5, 0.4))).toBeNull();
    expect(badModel(readShape(boxGlb([1.2, 1, 0.4], 0.01, [0.2, 0.4, -0.3])))).toBeNull();
  });
  it('rejects empty, zero-height and non-finite geometry', () => {
    expect(badModel({ positions: new Float32Array(), triangles: new Uint32Array() })).not.toBeNull();
    expect(badModel(box(1, 0, 1))).not.toBeNull();
    for (const value of [NaN, Infinity]) {
      const s = box(1, 1, 1); s.positions[0] = value;
      expect(badModel(s)).toMatch(/^invalid/);
    }
  });
});
