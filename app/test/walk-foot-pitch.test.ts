import { expect, test } from 'vitest';
import { swingFootPitch } from '../web/hero3d.ts';

test('the foot meets its planted orientation at both ends of the swing', () => {
  for (const u of [0, 1]) expect(Math.abs(swingFootPitch(u))).toBeLessThan(1e-12);
  for (const u of [1e-5, 1 - 1e-5]) expect(Math.abs(swingFootPitch(u))).toBeLessThan(1e-4);
});

test('ending the toe-off correction introduces no angle or velocity jump', () => {
  const u = 0.3, h = 1e-5;
  const before = swingFootPitch(u - h), at = swingFootPitch(u), after = swingFootPitch(u + h);
  expect(Math.abs(after - before)).toBeLessThan(1e-4);
  expect(Math.abs((after - at) / h - (at - before) / h)).toBeLessThan(0.001);
});

test('the full swing has bounded motion and keeps toe-off followed by toe lift', () => {
  const samples = Array.from({ length: 1001 }, (_, i) => swingFootPitch(i / 1000));
  const changes = samples.slice(1).map((value, i) => Math.abs(value - samples[i]));
  expect(Math.max(...changes)).toBeLessThan(0.004);
  expect(Math.min(...samples.slice(0, 300))).toBeLessThan(-0.05);
  expect(swingFootPitch(0.5)).toBeCloseTo(0.35, 10);
});
