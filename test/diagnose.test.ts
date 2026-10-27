import { expect, test } from 'vitest';
import type { Geometry } from '../src/play/geometry.ts';
import { diagnose } from '../src/scene/diagnose.ts';
import { emptyMask } from '../src/image/mask.ts';

/** 1200x896 at 8 px: a front floor and a back floor with a band of closed rows between. */
function geometry(band: [number, number]): Geometry {
  const cols = 150;
  const walk: string[] = [];
  const zone: string[] = [];
  for (let r = 0; r < 112; r++) {
    const floor = r >= 30 && r < 60 ? '1' : r >= 60 ? '0' : '.';
    const open = floor !== '.' && !(r >= band[0] && r < band[1]);
    walk.push((open ? '#' : '.').repeat(cols));
    zone.push((floor !== '.' ? floor : '.').repeat(cols));
  }
  return {
    frame: { width: 1200, height: 896 }, cell: 8, walk, zone,
    scale: { horizonY: 100, pxPerY: 0.5, source: 'spark' },
    start: [600, 850],
    things: [
      { key: 'bell', role: 'item', box: [100, 260, 140, 300], stand: [120, 300] },
    ],
    occluders: [],
  } as Geometry;
}

test('an unreached floor comes with the 60 px cells of its shortest gap, and an unreachable spot with the nearest reachable point', () => {
  const d = diagnose(geometry([58, 64]));
  expect(d.floors.find((f) => f.floor === 1)!.reached).toBe(0);
  expect(d.patches).toHaveLength(1);
  const gap = d.patches[0].gap!;
  expect(gap.px).toBeLessThan(60);
  expect(gap.cells.length).toBeGreaterThan(0);
  for (const c of gap.cells) expect(c).toMatch(/^[A-T](8|9)$/);
  expect(d.patches[0].floors).toEqual([1]);
  expect(d.spots).toEqual([expect.objectContaining({ thing: 'bell', nearest: expect.any(Array) })]);
});

test('a place that walks everywhere has no patches', () => {
  const d = diagnose(geometry([0, 0]));
  expect(d.patches).toEqual([]);
  expect(d.start.onFloor).toBe(true);
});

test('a mask Spark sees on the wrong thing: an error for an item, its box handed to SAM by the free fixes', async () => {
  const { verifyPlace } = await import('../src/scene/verify.ts');
  const { autoFixes } = await import('../src/scene/autofix.ts');
  const { readCorrections } = await import('../src/scene/corrections.ts');
  const g = geometry([0, 0]);
  g.things[0] = { ...g.things[0], stand: [120, 500], mask: 'masks/bell.png' };
  const place = { key: 'quay', shows: 'a quay at dusk', mood: 'calm', exits: [], things: [{ key: 'bell', role: 'item', looks: 'a small brass bell' }] } as never;
  const notes = { things: { bell: { coarse: false, source: 'sam-text', check: { ok: false, seen: 'a grey stone', box: [300, 600, 340, 640] as [number, number, number, number] } } }, floors: {} };
  const v = verifyPlace(place, g, notes);
  const wrong = v.errors.find((e) => e.code === 'MASK_WRONG')!;
  expect(wrong).toMatchObject({ key: 'bell', box: [300, 600, 340, 640] });
  expect(wrong.detail).toMatch(/grey stone/);
  const fixes = autoFixes(g, ['deck', 'quay'], v.errors);
  const c = readCorrections('/nowhere');
  for (const f of fixes) f.apply(c);
  expect(c.things.bell.box).toEqual([300, 600, 340, 640]);
  expect(fixes.find((f) => f.what.includes('bell'))!.from).toBe('masks');
});

test('a long gap is bridged only along stairs whose mask reaches both floors, never across bare ground or a standing thing', async () => {
  const { autoFixes } = await import('../src/scene/autofix.ts');
  const err = [{ code: 'FLOOR_UNREACHABLE', key: '1', detail: 'floor 1 has walkable cells but none reachable' }];
  const g = geometry([50, 80]);
  expect(autoFixes(g, ['quay', 'deck'], err)).toEqual([]);
  const stairs = { ...g, things: [{ key: 'stairs', kind: 'walk-on' as const, role: 'prop' as const, box: [0, 380, 1200, 660] as [number, number, number, number], stand: [600, 860] as [number, number] }] };
  const band = (y0: number, y1: number) => {
    const m = emptyMask(1200, 896);
    m.bits.fill(1, y0 * 1200, y1 * 1200);
    return m;
  };
  const fixes = autoFixes(stairs, ['quay', 'deck'], err, { stairs: band(380, 660) });
  expect(fixes).toHaveLength(1);
  expect(fixes[0].what).toMatch(/along stairs/);
  // Stairs that climb from the far floor to somewhere else, with water before the near floor, join nothing.
  expect(autoFixes(stairs, ['quay', 'deck'], err, { stairs: band(200, 420) })).toEqual([]);
  // No mask to check: no bridge on the strength of a box alone.
  expect(autoFixes(stairs, ['quay', 'deck'], err)).toEqual([]);
  const wall = { ...stairs, things: [{ ...stairs.things[0], kind: 'standing' as const }] };
  expect(autoFixes(wall, ['quay', 'deck'], err, { stairs: band(380, 660) })).toEqual([]);
});

test('a mask check doubt without a box is a flag, not an error', async () => {
  const { verifyPlace } = await import('../src/scene/verify.ts');
  const g = geometry([0, 0]);
  g.things[0] = { ...g.things[0], stand: [120, 500], mask: 'masks/bell.png' };
  const place = { key: 'quay', shows: 'a quay at dusk', mood: 'calm', exits: [], things: [{ key: 'bell', role: 'item', looks: 'a small brass bell' }] } as never;
  const v = verifyPlace(place, g, { things: { bell: { coarse: false, source: 'sam-text', check: { ok: false, seen: 'a bronze bell', box: null } } }, floors: {} });
  expect(v.errors.map((e) => e.code)).not.toContain('MASK_WRONG');
  expect(v.flags.map((f) => f.code)).toContain('MASK_DOUBT');
});
