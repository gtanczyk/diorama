// A rough geometry.json made from layout.json alone, so a place can be walked before its masks exist.
// Everything here is the plan, not the painting, so it is marked preview and every thing coarse.
import type { Layout } from '../scene/layout.ts';
import type { Place } from '../world/schema.ts';
import type { Geometry } from './geometry.ts';
import { WalkGrid, type Point } from './path.ts';

const CELL = 8;

function inside(poly: Array<[number, number]>, x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** px per y of a 1.62 m person, fitted to the things' heights with the horizon fixed. */
function fitScale(layout: Layout): number {
  let num = 0;
  let den = 0;
  for (const t of layout.things) {
    const d = t.footY - layout.horizon;
    if (d <= 20 || t.metres <= 0) continue;
    const want = (t.height * 1.62) / t.metres;
    num += want * d;
    den += d * d;
  }
  const c = den ? num / den : 0.5;
  return Math.min(4, Math.max(0.15, c));
}

export function previewGeometry(layout: Layout, place: Place, frame = { width: 1200, height: 896 }): Geometry {
  const cols = Math.ceil(frame.width / CELL);
  const rows = Math.ceil(frame.height / CELL);
  const roles = new Map(place.things.map((t) => [t.key, t.role]));
  const solid = layout.things.filter((t) => roles.get(t.key) !== 'npc');
  const walk: string[] = [];
  const zone: string[] = [];
  for (let r = 0; r < rows; r++) {
    let w = '';
    let z = '';
    for (let c = 0; c < cols; c++) {
      const x = (c + 0.5) * CELL;
      const y = (r + 0.5) * CELL;
      const floor = layout.floors.findIndex((f) => inside(f.outline, x, y));
      // A thing's footprint: the floor under its lower third, as deep as a third of its width.
      const blocked = solid.some((t) => Math.abs(x - t.x) < t.width * 0.45 && y <= t.footY + 2 && y >= t.footY - Math.max(10, t.width / 3));
      w += floor >= 0 && !blocked ? '#' : '.';
      z += floor >= 0 ? String(floor) : '.';
    }
    walk.push(w);
    zone.push(z);
  }
  const grid = new WalkGrid({ cell: CELL, walk });
  const near = (x: number, y: number): Point => grid.snap(x, y) ?? [x, y];
  const box = (t: Layout['things'][number]): [number, number, number, number] => [t.x - t.width / 2, t.footY - t.height, t.x + t.width / 2, t.footY];
  return {
    frame,
    cell: CELL,
    walk,
    zone,
    scale: { horizonY: layout.horizon, pxPerY: fitScale(layout), source: 'layout' },
    start: near(frame.width / 2, frame.height - 120),
    things: layout.things.map((t) => ({ key: t.key, role: roles.get(t.key), box: box(t), stand: near(t.x, t.footY + 14), coarse: true })),
    occluders: solid.map((t) => ({ key: t.key, thing: t.key, box: box(t), baseY: t.footY })),
    preview: true,
  };
}
