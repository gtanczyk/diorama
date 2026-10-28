import { describe, expect, it } from 'vitest';
import { creatureMotion } from '../src/play/creature.ts';

describe('creature motion', () => {
  const walk = [...Array(40).keys()].map((i) => creatureMotion({ phase: i / 40, walking: true }));
  it('hops once per walk cycle: on the ground squashed, in the air up', () => {
    expect(walk.filter((m) => m.lift === 0).length).toBeGreaterThan(5);
    expect(Math.max(...walk.map((m) => m.lift))).toBeGreaterThan(0.25);
    expect(Math.min(...walk.map((m) => m.stretch))).toBeLessThan(0.85);
    expect(walk.every((m) => m.lean > 0)).toBe(true);
  });
  it('stands on the ground breathing and now and then blinks', () => {
    const still = [...Array(400).keys()].map((i) => creatureMotion({ time: i / 50 }));
    expect(still.every((m) => m.lift === 0 && m.lean === 0)).toBe(true);
    expect(Math.min(...still.map((m) => m.stretch))).toBeLessThan(0.9);
    expect(Math.max(...still.map((m) => m.stretch))).toBeLessThan(1.03);
  });
  it('bounces on its words', () => {
    const talk = [...Array(100).keys()].map((i) => creatureMotion({ time: i / 50, talk: 'speak' }));
    expect(Math.max(...talk.map((m) => m.lift))).toBeGreaterThan(0.02);
  });
});
