import { describe, expect, it } from 'vitest';
import { area, outlineLoops, softAlpha } from '../src/play/outline-path.ts';

const square = (w: number, h: number, [x0, y0, x1, y1]: [number, number, number, number], hole?: [number, number, number, number]) => {
  const a = new Uint8Array(w * h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) a[y * w + x] = 255;
  if (hole) for (let y = hole[1]; y < hole[3]; y++) for (let x = hole[0]; x < hole[2]; x++) a[y * w + x] = 0;
  return a;
};

describe('outlineLoops', () => {
  it('rings a filled square close to its edge', () => {
    const loops = outlineLoops(square(40, 40, [10, 10, 30, 30]), 40, 40, { smooth: 0 });
    expect(loops).toHaveLength(1);
    expect(Math.abs(area(loops[0]))).toBeGreaterThan(19 * 19);
    expect(Math.abs(area(loops[0]))).toBeLessThan(21 * 21);
    for (const [x, y] of loops[0]) {
      expect(x).toBeGreaterThanOrEqual(9.5);
      expect(x).toBeLessThanOrEqual(30.5);
      expect(y).toBeGreaterThanOrEqual(9.5);
      expect(y).toBeLessThanOrEqual(30.5);
    }
  });

  it('drops specks and small holes, keeps big holes', () => {
    const a = square(60, 60, [5, 5, 55, 55], [10, 10, 13, 13]);
    for (let y = 20; y < 40; y++) for (let x = 20; x < 40; x++) a[y * 60 + x] = 0;
    a[2 * 60 + 2] = 255;
    const loops = outlineLoops(a, 60, 60, { minArea: 30 });
    expect(loops).toHaveLength(2);
    const [outer, hole] = loops.sort((p, q) => Math.abs(area(q)) - Math.abs(area(p)));
    expect(Math.sign(area(outer))).not.toBe(Math.sign(area(hole)));
  });

  it('closes a shape that touches the frame edge', () => {
    expect(outlineLoops(square(20, 20, [0, 0, 20, 10]), 20, 20)).toHaveLength(1);
  });
});

describe('softAlpha', () => {
  it('keeps a big shape whole inside and halves it along its edge', () => {
    const a = softAlpha(square(30, 30, [5, 5, 25, 25]), 30, 30, 2);
    expect(a[15 * 30 + 15]).toBe(255);
    expect(a[15 * 30 + 0]).toBe(0);
    expect(Math.abs(a[15 * 30 + 5] - 128)).toBeLessThan(70);
  });
});

describe('outline holes', () => {
  it('runs outer loops clockwise and drops holes under minHole', () => {
    const a = square(60, 60, [5, 5, 55, 55]);
    for (let y = 20; y < 30; y++) for (let x = 20; x < 30; x++) a[y * 60 + x] = 0;
    expect(outlineLoops(a, 60, 60, { minHole: 50 }).map((l) => Math.sign(area(l)))).toEqual([1, -1]);
    expect(outlineLoops(a, 60, 60, { minHole: 200 })).toHaveLength(1);
  });
});
