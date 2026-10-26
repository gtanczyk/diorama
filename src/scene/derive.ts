// derive: the masks become geometry.json, everything the runtime needs to walk a place.
// Walkable = floors and walk-on things, minus things in the way, plus the floor hidden behind a
// standing thing, minus each standing thing's footprint. Then the grid is joined up, the hero's
// size is measured, and every thing gets a spot to stand at.
import { emptyMask, type Mask } from '../image/mask.ts';
import { maskBox, polygonMask, subtract, union, unionAll } from '../image/raster.ts';
import type { Memo } from '../meta/memo.ts';
import type { Geometry } from '../play/geometry.ts';
import type { Place } from '../world/schema.ts';
import { FRAME, type Layout } from './layout.ts';
import type { Kind } from './locate.ts';
import type { MaskSource } from './masks.ts';
import { blobsOf, footDepth, lineYAt, simplifyLine, type Blob } from './occluders.ts';
import { PERSON_M, probePoints, scaleFrom, sparkPeople, type Sample, type Scale } from './scale.ts';
import { CELL, connect, gridFromPixels, nearestRoomy, reach, roomy, type Grid } from './walk.ts';

export type ThingIn = { key: string; kind: Kind; source: MaskSource; coarse: boolean; mask: Mask };
export type DeriveIn = { place: Place; layout: Layout; things: ThingIn[]; floors: Mask[]; painting: Buffer };
export type Derived = { geometry: Geometry; grid: Grid; blobs: Blob[]; footprint: Mask; probes: Sample[] };

const { width: W, height: H } = FRAME;

/** The floor hidden behind a standing blob: its pixels behind the footprint, in rows with floor on both sides. */
export function hiddenFloor(blob: Blob, floor: Mask, reachPx = 24): Mask {
  const out = emptyMask(W, H);
  const [x0, y0, , y1] = blob.box;
  const depth = footDepth(blob.line[blob.line.length - 1][0] - blob.line[0][0]);
  for (let y = y0; y < y1; y++) {
    let left = -1;
    let right = -1;
    for (let x = blob.box[0]; x < blob.box[2]; x++) {
      if (!blob.mask.bits[y * W + x]) continue;
      if (left < 0) left = x;
      right = x;
    }
    if (left < 0) continue;
    const floorNear = (from: number, to: number) => {
      for (let x = Math.max(0, from); x <= Math.min(W - 1, to); x++) if (floor.bits[y * W + x]) return true;
      return false;
    };
    if (!floorNear(left - reachPx, left - 1) || !floorNear(right + 1, right + reachPx)) continue;
    for (let x = left; x <= right; x++) {
      if (x < x0) continue;
      if (blob.mask.bits[y * W + x] && y < lineYAt(blob.line, x) - depth) out.bits[y * W + x] = 1;
    }
  }
  return out;
}

/** The rows of each standing blob's foot: no one stands inside a barrel. */
export function footprintMask(blobs: Blob[]): Mask {
  const out = emptyMask(W, H);
  for (const blob of blobs) {
    const from = blob.line[0][0];
    const to = blob.line[blob.line.length - 1][0];
    const depth = footDepth(to - from);
    for (let x = from; x <= to && x < W; x++) {
      const front = lineYAt(blob.line, x);
      for (let y = Math.max(0, Math.round(front - depth)); y < Math.min(H, Math.round(front + 2)); y++) out.bits[y * W + x] = 1;
    }
  }
  return out;
}

/** Scale anchors from things with a real height in the layout, measured on their masks. */
function anchorSamples(blobs: Blob[], layout: Layout): Sample[] {
  return blobs.flatMap((b) => {
    const metres = layout.things.find((t) => t.key === b.thing)?.metres;
    const tall = b.baseY - b.box[1];
    return metres && tall > 10 ? [{ y: b.baseY, px: (tall * PERSON_M) / metres }] : [];
  });
}

export async function derive(memo: Memo, input: DeriveIn, log: (line: string) => void): Promise<Derived> {
  const { place, layout, things, floors, painting } = input;
  const role = new Map(place.things.map((t) => [t.key, t.role]));
  const floorAny = unionAll(W, H, floors);
  const walkOn = unionAll(W, H, things.filter((t) => t.kind === 'walk-on').map((t) => t.mask));
  const inTheWay = unionAll(W, H, things.filter((t) => t.kind !== 'walk-on').map((t) => t.mask));
  const ground = union(floorAny, walkOn);

  // Standing things (and things on top of nothing) meet the floor; coarse masks still block it.
  const standing = things.filter((t) => t.kind === 'standing' || t.kind === 'on-top');
  const blobs = standing.flatMap((t) => blobsOf(t.key, t.mask));
  const onFloor = blobs.filter((b) => things.find((t) => t.key === b.thing)!.kind === 'standing');
  const footprint = footprintMask(onFloor);
  const behind = unionAll(W, H, onFloor.map((b) => hiddenFloor(b, ground)));
  const walkPx = subtract(union(subtract(ground, inTheWay), behind), footprint);

  const floorOf = (p: number) => floors.findIndex((f) => f.bits[p]);
  const grid = gridFromPixels(walkPx, floorOf, floors.length);
  const flagged: string[] = [];
  const flag = (line: string) => {
    flagged.push(line);
    log(line);
  };

  // Join up the floor: closed cells on a painted floor are cheap to open, the layout's floors dearer,
  // things and footprints never.
  const planned = unionAll(W, H, layout.floors.map((f) => polygonMask(W, H, f.outline)));
  const blocked = union(inTheWay, footprint);
  const groundTop = Math.min(...floors.map((f) => maskBox(f)?.[1] ?? H), ...layout.floors.flatMap((f) => f.outline.map(([, y]) => y)));
  const cost = (i: number) => {
    const [x, y] = grid.centre(i).map(Math.floor);
    const p = Math.min(H - 1, y) * W + Math.min(W - 1, x);
    if (blocked.bits[p] && !behind.bits[p]) return Infinity;
    // Muse moves floors away from the layout, so the ground between them is fair game too, at a price.
    return ground.bits[p] ? 1 : planned.bits[p] ? 3 : y >= groundTop ? 6 : Infinity;
  };
  const startCell = nearestRoomy(grid, W / 2, H - 40);
  if (startCell === undefined) throw new Error(`${place.key}: no walkable floor at all`);
  const joined = connect(grid, startCell, cost);
  if (joined.reopened) flag(`opened ${joined.reopened} cells to join the floor up`);
  if (joined.dropped) log(`closed ${joined.dropped} cells in specks cut off from the start`);
  for (const island of joined.stranded) flag(`${island.length} walkable cells can't be reached from the start`);

  // Scale: Spark's people first, then the things' heights, then the layout.
  const open = [...grid.open.keys()].filter((i) => grid.open[i]);
  const topY = Math.min(...open.map((i) => grid.centre(i)[1])) - CELL / 2;
  const byRow = new Map<number, number[]>();
  for (const i of open) {
    const [x, y] = grid.centre(i);
    byRow.set(y, [...(byRow.get(y) ?? []), x]);
  }
  const probes = await sparkPeople(memo, `scale:${place.key}`, painting, probePoints([...byRow].map(([y, xs]) => ({ y, xs }))));
  let scale: Scale | undefined;
  for (const [source, samples] of [['spark', probes], ['anchors', anchorSamples(onFloor.filter((b) => !things.find((t) => t.key === b.thing)!.coarse), layout)]] as const) {
    const fit = scaleFrom(samples, topY, layout.horizon, source);
    if (fit.scale) {
      scale = fit.scale;
      break;
    }
    flag(`scale from ${source}: ${fit.why}`);
  }
  if (!scale) {
    scale = { horizonY: Math.min(layout.horizon, topY - 40), pxPerY: 0.5, source: 'layout' };
    flag('scale: guessed from the layout horizon');
  }

  /** The standing blob a thing on top rests on: its middle column is over it, its base near or inside it. */
  const support = (b: Blob) => {
    const [mx] = b.line[Math.floor(b.line.length / 2)];
    return onFloor.find((o) => o.thing !== b.thing && mx >= o.box[0] && mx <= o.box[2] && b.baseY >= o.box[1] - 10 && b.baseY <= o.baseY + 10);
  };

  // Spots to stand at: the reachable roomy cell nearest the front of each thing (of its support, for a thing on top).
  const cells = roomy(grid);
  const reached = reach(grid, startCell, cells);
  const spot = (x: number, y: number): [number, number] => {
    const i = nearestRoomy(grid, x, y, reached) ?? startCell;
    return grid.centre(i);
  };
  const geoThings: Geometry['things'] = place.things.map((t) => {
    const thing = things.find((m) => m.key === t.key);
    if (!thing) {
      const l = layout.things.find((b) => b.key === t.key)!;
      return { key: t.key, role: t.role, box: [l.x - l.width / 2, l.footY - l.height, l.x + l.width / 2, l.footY], stand: spot(l.x, l.footY), coarse: true };
    }
    const own = blobs.filter((b) => b.thing === t.key);
    const box = maskBox(thing.mask) ?? [0, 0, 0, 0];
    const cx = (box[0] + box[2]) / 2;
    const under = thing.kind === 'on-top' && own[0] ? support(own[0]) : undefined;
    const baseY = under ? under.baseY : own.length ? Math.max(...own.map((b) => b.baseY)) : box[3];
    const stand = thing.kind === 'walk-on' || thing.kind === 'flat' ? spot(cx, (box[1] + box[3]) / 2) : spot(cx, baseY + 14);
    return { key: t.key, role: t.role, kind: thing.kind, box, mask: `masks/${t.key}.png`, stand, ...(thing.coarse && { coarse: true }) };
  });
  for (const t of geoThings) {
    // Npcs stand where the layout put them; wall things (a ship at sea) may be far from any floor.
    if (role.get(t.key) === 'npc' || t.kind === 'wall' || t.kind === 'on-top') continue;
    const [sx, sy] = t.stand;
    const gap = Math.max(0, t.box[0] - sx, sx - t.box[2], t.box[1] - sy, sy - t.box[3] - 60);
    if (gap > 80) flag(`${t.key}: the nearest reachable spot is ${Math.round(gap)} px away`);
  }

  // Occluders: sharp masks only. A coarse box would cut a rectangle out of the hero.
  const occluders: Geometry['occluders'] = [];
  for (const b of blobs) {
    const thing = things.find((t) => t.key === b.thing)!;
    if (thing.coarse) continue;
    const base = { key: b.key, thing: b.thing, box: b.box, mask: `masks/${b.thing}.png`, baseY: b.baseY, floor: simplifyLine(b.line), ...(b.front && { front: true }) };
    if (thing.kind === 'on-top') {
      const under = support(b);
      occluders.push(under ? { ...base, on: under.key } : base);
    } else {
      occluders.push({ ...base, foot: b.foot });
    }
  }
  for (const t of things) if (t.coarse && t.kind === 'standing') flag(`${t.key}: coarse mask, it blocks the floor but hides no one`);
  // The runtime gives each occluder pixel to the first box that holds it: small boxes first.
  occluders.sort((a, b) => (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]) - (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]));

  const { walk, zone } = grid.rowsOut();
  const geometry: Geometry = {
    frame: { width: W, height: H },
    cell: CELL,
    walk,
    zone,
    scale,
    start: grid.centre(startCell),
    things: geoThings,
    occluders,
    flagged,
  };
  return { geometry, grid, blobs, footprint, probes };
}
