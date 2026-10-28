import { describe, expect, it } from 'vitest';
import { badModel, type Shape } from '../src/model/glb.ts';

/** A box of vertices, width x height x depth, as a Shape (triangles do not matter to badModel). */
function box(w: number, h: number, d: number): Shape {
  const p: number[] = [];
  for (let i = 0; i < 2000; i++) p.push((Math.random() - 0.5) * w, Math.random() * h, (Math.random() - 0.5) * d);
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
});
