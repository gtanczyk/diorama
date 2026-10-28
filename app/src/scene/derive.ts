// derive: the masks become geometry.json, everything the runtime needs to walk a place.
// Walkable = floors and walk-on things, minus things in the way, plus the floor hidden behind a
// standing thing, minus each standing thing's footprint. Then the grid is joined up, the hero's
// size is measured, and every thing gets a spot to stand at.
import { emptyMask, maskArea, type Mask } from '../image/mask.ts';
import { dilate, maskBox, polygonMask, subtract, union, unionAll } from '../image/raster.ts';
import type { Memo } from '../meta/memo.ts';
import type { Geometry } from '../play/geometry.ts';
import type { Place } from '../world/schema.ts';
import { FRAME, type Layout } from './layout.ts';
import type { Kind } from './locate.ts';
import type { MaskSource } from './masks.ts';
import { blobsOf, footDepth, lineYAt, simplifyLine, type Blob } from './occluders.ts';
import { findShadows, localLight, type Shadows } from './shadows.ts';
import { atFrame, findSteps, STAIRS } from './stairs.ts';
import { paintingFor, reaches, type Carry } from './carry.ts';
import { doorCheck, isDoor, PERSON_M, probePoints, scaleFrom, sparkPeople, type DoorRef, type Sample, type Scale } from './scale.ts';
import { CELL, connect, gridFromPixels, islands, nearestRoomy, reach, roomy, type Grid } from './walk.ts';
import { samFind } from '../meta/sam.ts';

export type ThingIn = { key: string; kind: Kind; phrase?: string; source: MaskSource; coarse: boolean; mask: Mask };
/** `plates`: things that have a clean plate (plates/<key>.png), for the runtime to hide them once taken. */
/**
 * carry: after a small repaint, each question whose region the change does not reach is asked about the old painting; lastScale: the scale it had.
 * previousScale: the scale the place had before this run, whatever ran; kept when Spark cannot be asked now.
 */
export type DeriveIn = { place: Place; layout: Layout; things: ThingIn[]; floors: Mask[]; painting: Buffer; plates?: string[]; carry?: Carry; lastScale?: Scale; previousScale?: Scale };
export type Derived = { geometry: Geometry; grid: Grid; blobs: Blob[]; footprint: Mask; probes: Sample[]; shadows: Shadows };

const { width: W, height: H } = FRAME;
/** The tallest the hero may be: three quarters of the picture. */
export const NEAR_MAX_PX = Math.round(0.75 * H);
/** How far (px) a layout light's point may lie outside the thing it belongs to: a glow drawn just off the lamp. */
const LIGHT_REACH = 24;

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

/**
 * Doors standing on the floor, measured on their masks (the tallest piece): the person at a door's foot, and
 * the door as a reference for Spark. A door cut off by the top of the frame only says how tall a person is at least.
 */
export function doorsOn(things: ThingIn[], layout: Layout, ground: Mask): Array<{ door: DoorRef; ref: { key: string; x: number; footY: number; px: number; metres: number } }> {
  return things.flatMap((t) => {
    const metres = layout.things.find((l) => l.key === t.key)?.metres;
    if (t.kind === 'walk-on' || t.kind === 'flat' || t.coarse || !isDoor(`${t.key} ${t.phrase ?? ''}`, metres)) return [];
    const b = blobsOf(t.key, t.mask).sort((p, q) => q.baseY - q.box[1] - (p.baseY - p.box[1]))[0];
    if (!b) return [];
    const tall = b.baseY - b.box[1];
    const x = Math.round((b.box[0] + b.box[2]) / 2);
    // On the floor: floor just under its foot, in the middle half of its width.
    let floorBelow = false;
    for (let y = Math.round(b.baseY); y < Math.min(H, b.baseY + 16) && !floorBelow; y++) {
      for (let u = Math.round(b.box[0] + (b.box[2] - b.box[0]) / 4); u <= x + (b.box[2] - b.box[0]) / 4; u += 2) if (ground.bits[y * W + u]) floorBelow = true;
    }
    if (!floorBelow || tall < 40 || !metres) return [];
    return [{ door: { key: t.key, y: b.baseY, px: (tall * PERSON_M) / metres, atLeast: b.box[1] <= 2 }, ref: { key: t.key, x, footY: b.baseY, px: tall, metres } }];
  });
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
  const { place, layout, things, floors, painting, carry } = input;
  const role = new Map(place.things.map((t) => [t.key, t.role]));
  const floorAny = unionAll(W, H, floors);
  const walkOn = unionAll(W, H, things.filter((t) => t.kind === 'walk-on').map((t) => t.mask));
  const inTheWay = unionAll(W, H, things.filter((t) => t.kind !== 'walk-on').map((t) => t.mask));
  const ground = union(floorAny, walkOn);

  // Standing things (and things on top of nothing) meet the floor; coarse masks still block it.
  const standing = things.filter((t) => t.kind === 'standing' || t.kind === 'on-top');
  const blobs = standing.flatMap((t) => blobsOf(t.key, t.mask));
  const onFloor = blobs.filter((b) => things.find((t) => t.key === b.thing)!.kind === 'standing');
  // A coarse mask is a box, not a silhouette: nobody walks behind it, and all of it is in the way.
  const isCoarse = (b: Blob) => things.find((t) => t.key === b.thing)!.coarse;
  const footprint = union(footprintMask(onFloor), unionAll(W, H, onFloor.filter(isCoarse).map((b) => b.mask)));
  const behind = unionAll(W, H, onFloor.filter((b) => !isCoarse(b)).map((b) => hiddenFloor(b, ground)));
  const walkPx = subtract(union(subtract(ground, inTheWay), behind), footprint);

  const floorOf = (p: number) => floors.findIndex((f) => f.bits[p]);
  let grid = gridFromPixels(walkPx, floorOf, floors.length);
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
  const nearFloor = dilate(union(ground, planned), 48);
  let water: Mask | undefined;
  // Cells the gates below shut stay shut: joining the floor up again must not reopen them.
  const shut = new Uint8Array(grid.open.length);
  const cost = (i: number) => {
    if (shut[i]) return Infinity;
    const [x, y] = grid.centre(i).map(Math.floor);
    const p = Math.min(H - 1, y) * W + Math.min(W - 1, x);
    if (blocked.bits[p] && !behind.bits[p]) return Infinity;
    // Nobody walks on painted water, wherever the layout planned a floor.
    if (water?.bits[p]) return Infinity;
    // Muse moves floors away from the layout, so the ground between them is fair game too, at a price.
    // A corridor between floors stays near them: no paths cut across a lawn or open water.
    return ground.bits[p] ? 1 : planned.bits[p] ? 3 : y >= groundTop && nearFloor.bits[p] ? 6 : Infinity;
  };
  // The start is clear of every thing (by about a hero's width), so nobody begins standing in a lamp.
  // Walk-on and flat things (a jetty, a rug) are floor: near them is fine.
  const nearThings = dilate(unionAll(W, H, things.filter((t) => t.kind !== 'walk-on' && t.kind !== 'flat').map((t) => t.mask)), 24);
  // The start is on the biggest stretch of floor, as near the front middle as it can be: a strip of
  // quay cut off by the river is not where the game begins.
  const startOf = (): number | undefined => {
    const clear = roomy(grid).map((v, i) => {
      const [x, y] = grid.centre(i).map(Math.floor);
      return v && !nearThings.bits[Math.min(H - 1, y) * W + Math.min(W - 1, x)] ? 1 : 0;
    });
    const biggest = islands(grid, clear).sort((a, b) => b.length - a.length)[0] ?? [];
    const main = new Uint8Array(clear.length);
    biggest.forEach((i) => (main[i] = 1));
    return nearestRoomy(grid, W / 2, H - 40, main) ?? nearestRoomy(grid, W / 2, H - 40, clear) ?? nearestRoomy(grid, W / 2, H - 40);
  };
  let startCell = startOf();
  if (startCell === undefined) throw new Error(`${place.key}: no walkable floor at all`);
  let joined = connect(grid, startCell, cost);
  // Joining floors may have laid a path across the water between them: SAM finds the water (only then),
  // and the floor is joined again around it.
  if (joined.reopened) {
    // The water found last time stands when the change reaches none of it.
    const ask = (image: Buffer) => samFind(memo, { label: `water:${place.key}/painting`, image, prompt: 'water' });
    let hits = await ask(carry?.old ?? painting);
    if (carry && reaches(carry, hits.map((f) => atFrame(f.mask)))) hits = await ask(painting);
    const wet = subtract(unionAll(W, H, hits.map((f) => atFrame(f.mask))), ground);
    const fresh = gridFromPixels(walkPx, floorOf, floors.length);
    const wetAt = (i: number) => {
      const [x, y] = grid.centre(i).map(Math.floor);
      return wet.bits[Math.min(H - 1, y) * W + Math.min(W - 1, x)] === 1;
    };
    if (maskArea(wet) >= 4000 && grid.open.some((v, i) => v && !fresh.open[i] && wetAt(i))) {
      water = wet;
      grid = fresh;
      startCell = startOf()!;
      joined = connect(grid, startCell, cost);
      log(`water between the floors: joined again around it`);
    }
  }
  if (joined.reopened) flag(`opened ${joined.reopened} cells to join the floor up`);
  if (joined.dropped) log(`closed ${joined.dropped} cells in specks cut off from the start`);
  for (const island of joined.stranded) flag(`${island.length} walkable cells can't be reached from the start`);

  // Scale: Spark's people first, then the things' heights, then the layout.
  const open = [...grid.open.keys()].filter((i) => grid.open[i]);
  const topY = Math.min(...open.map((i) => grid.centre(i)[1])) - CELL / 2;
  // Probe points come from the painted floor, not the grid, so later gates don't move them
  // (a moved point is a new question, and Spark's answers vary from question to question).
  const byRow = new Map<number, number[]>();
  for (let y = CELL / 2; y < H; y += CELL) {
    for (let x = CELL / 2; x < W; x += CELL) if (floorAny.bits[y * W + x]) byRow.set(y, [...(byRow.get(y) ?? []), x]);
  }
  const sharpOnFloor = onFloor.filter((b) => !things.find((t) => t.key === b.thing)!.coarse);
  // Doors on the floor (a wall thing, so not among the standing ones): the plainest measure of a person there is.
  const doors = doorsOn(things, layout, ground);
  const refs = [...sharpOnFloor.flatMap((b) => {
    const metres = layout.things.find((t) => t.key === b.thing)?.metres;
    return metres ? [{ key: b.thing, x: (b.box[0] + b.box[2]) / 2, footY: b.baseY, px: b.baseY - b.box[1], metres }] : [];
  }), ...doors.map((d) => d.ref)];
  // Spark's questions about one painting are asked side by side: they do not wait on each other.
  // Painted shadows on the open floor, and the light they tell of.
  // Casters: sharp things on the floor, and things resting on walkable ground (a basket on the steps) too.
  const restsOnGround = (b: Blob) => ground.bits[Math.min(H - 1, Math.round(b.baseY) + 3) * W + Math.round((b.box[0] + b.box[2]) / 2)] === 1;
  const casters = [...sharpOnFloor, ...blobs.filter((b) => !onFloor.includes(b) && !isCoarse(b) && restsOnGround(b))];
  const lit = subtract(ground, dilate(inTheWay, 2));
  // The painted shadows are measured where the change reaches them; where the sun is does not move with a repaint
  // (a lamp lit by one is the light below), so Spark is asked about the painting before it.
  const shadowsAsked = findShadows(memo, place.key, paintingFor(carry, painting, [lit, ...casters.map((b) => b.box)], 24), lit, casters, carry?.old ?? painting);
  // A fire or a lamp outshining the sky throws each person's shadow away from itself.
  // The layout names a light by its glow ("lamp-glow" at the lamp's head, "oven-fire") as often as by its
  // thing ("street-lamp", "warm-oven"), so a light that names no thing goes to a thing near its point: one
  // sharing a word with it, else one whose mask comes within reach of it. Floors and flat things hold no
  // light, and a light no thing holds (a lantern the painting has no mask for) is left out.
  const boxed = things.flatMap((t) => { const b = t.kind === 'walk-on' || t.kind === 'flat' ? undefined : maskBox(t.mask); return b ? [{ key: t.key, box: b, mask: t.mask }] : []; });
  const near = (b: [number, number, number, number], x: number, y: number) => x >= b[0] - LIGHT_REACH && x <= b[2] + LIGHT_REACH && y >= b[1] - LIGHT_REACH && y <= b[3] + LIGHT_REACH;
  const area = (b: [number, number, number, number]) => (b[2] - b[0]) * (b[3] - b[1]);
  const words = (k: string) => k.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const touches = (m: Mask, x: number, y: number) => {
    for (let v = Math.max(0, Math.round(y) - LIGHT_REACH); v <= Math.min(H - 1, Math.round(y) + LIGHT_REACH); v += 2) {
      for (let u = Math.max(0, Math.round(x) - LIGHT_REACH); u <= Math.min(W - 1, Math.round(x) + LIGHT_REACH); u += 2) if (m.bits[v * W + u]) return true;
    }
    return false;
  };
  const lights = [...new Map(layout.lights.flatMap((l) => {
    const around = boxed.filter((t) => near(t.box, l.x, l.y)).sort((a, b) => area(a.box) - area(b.box));
    const t = boxed.find((t) => t.key === l.key)
      ?? around.find((t) => words(t.key).some((w) => words(l.key).includes(w)))
      ?? around.find((t) => touches(t.mask, l.x, l.y));
    return t ? [[t.key, { key: t.key, box: t.box }] as const] : [];
  })).values()];
  // A repaint of a lamp or of its glow is asked again; one elsewhere does not change what lights the ground.
  const fireAsked = lights.length ? localLight(memo, `light-source:${place.key}`, paintingFor(carry, painting, lights.map((l) => l.box), 80), lights) : Promise.resolve(undefined);
  // Stairs: the walk-on things and floors named as stairs get their steps, so feet land on the treads.
  const looks = new Map(place.things.map((t) => [t.key, t.looks ?? '']));
  const stairs = unionAll(W, H, [
    ...things.filter((t) => t.kind === 'walk-on' && STAIRS.test(`${t.key} ${t.phrase ?? ''} ${looks.get(t.key)}`)).map((t) => t.mask),
    ...layout.floors.flatMap((f, i) => (STAIRS.test(`${f.key} ${f.is}`) && floors[i] ? [floors[i]] : [])),
  ]);
  const stepsAsked = findSteps(memo, place.key, paintingFor(carry, painting, stairs), stairs, log);
  // Their failures surface where they are awaited, below, not as an unhandled rejection while the scale is asked.
  for (const asked of [shadowsAsked, fireAsked, stepsAsked]) asked.catch(() => undefined);

  const points = probePoints([...byRow].map(([y, xs]) => ({ y, xs })));
  // A repaint changes how a place looks, not how big a person is in it, and Spark's sizes drift from one asking
  // to the next: after a small repaint the place keeps the scale it had.
  const kept = carry && input.lastScale;
  let sparkFailed = '';
  const probes = kept ? [] : await sparkPeople(memo, `scale:${place.key}`, painting, points, refs).catch((error) => ((sparkFailed = error instanceof Error ? error.message.slice(0, 160) : String(error)), [] as Sample[]));
  let scale: Scale | undefined = kept || undefined;
  if (kept) log(`scale kept from before the repaint (${kept.source})`);
  // Spark could not be asked (a network or model hiccup): the scale Spark gave this place before beats a guess from
  // object heights, which shrank a hero to a dwarf by a kitchen stove.
  if (sparkFailed) {
    flag(`scale from spark: the asks failed (${sparkFailed})`);
    if (input.previousScale?.source === 'spark') {
      scale = input.previousScale;
      log('scale kept from the last build, when Spark answered');
    }
  }
  let fitted: Sample[] = [];
  for (const [source, samples] of kept || scale ? [] : ([['spark', probes], ['anchors', anchorSamples(sharpOnFloor, layout)]] as const)) {
    if (source === 'spark' && sparkFailed) continue;
    const fit = scaleFrom(samples, topY, layout.horizon, source);
    if (fit.scale) {
      scale = fit.scale;
      fitted = samples;
      break;
    }
    flag(`scale from ${source}: ${fit.why}`);
  }
  // A person by the door is held against it: the nearest door (the tallest in the painting) is measured best.
  const door = [...doors].sort((a, b) => b.door.px - a.door.px)[0]?.door;
  if (scale && door && !kept) {
    const checked = doorCheck(scale, fitted, door, topY);
    if (checked?.scale) scale = checked.scale;
    if (checked) flag(`scale: ${checked.why}`);
  }
  if (!scale) {
    scale = { horizonY: Math.min(layout.horizon, topY - 40), pxPerY: 0.5, source: 'layout' };
    flag('scale: guessed from the layout horizon');
  }

  // The frame gate: no standing where a good part of the hero would be outside the picture.
  const sized = scale;
  let framed = 0;
  grid.open.forEach((v, i) => {
    if (!v) return;
    const [x, y] = grid.centre(i);
    const h = Math.max(8, sized.pxPerY * (y - sized.horizonY));
    if (x < 0.1 * h || x > W - 0.1 * h || y < 0.7 * h) {
      grid.open[i] = 0;
      shut[i] = 1;
      framed++;
    }
  });
  // The near gate: in a close-up interior the front rows sit right under the camera, where the hero would be
  // taller than the picture (a bakery at 942 px). Those rows are foreground to look past, not floor to stand on.
  const tooNear = [...grid.open.keys()].filter((i) => grid.open[i] && sized.pxPerY * (grid.centre(i)[1] - sized.horizonY) > NEAR_MAX_PX);
  if (tooNear.length && grid.count() - tooNear.length >= 200) {
    tooNear.forEach((i) => (grid.open[i] = 0, shut[i] = 1));
    framed += tooNear.length;
    flag(`closed ${tooNear.length} front cells where the hero would be over ${NEAR_MAX_PX} px tall (too near the camera)`);
  }
  if (framed) {
    log(`closed ${framed} cells at the frame edge or too near the camera, where the hero would be cut off`);
    if (!roomy(grid)[startCell]) startCell = startOf() ?? startCell;
    const again = connect(grid, startCell, cost);
    for (const island of again.stranded) flag(`${island.length} walkable cells can't be reached from the start after the frame gate`);
    joined.stranded = again.stranded;
  }
  // Floor walled off by a thing (a dock strip behind a kayak) is painted, not walkable: close it, as long as
  // it is a small part. A big part cut off means something else is wrong, and verify should say so.
  const cutOff = joined.stranded.flat();
  if (cutOff.length && cutOff.length < 0.25 * grid.count()) {
    cutOff.forEach((i) => (grid.open[i] = 0));
    flag(`closed ${cutOff.length} cells no path reaches (walled off by things)`);
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
    return { key: t.key, role: t.role, kind: thing.kind, box, mask: `masks/${t.key}.png`, stand, ...(thing.coarse && { coarse: true }), ...(input.plates?.includes(t.key) && { plate: `plates/${t.key}.png` }) };
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
  // The runtime gives each occluder pixel to the first box that holds it: small boxes first.
  occluders.sort((a, b) => (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]) - (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]));

  // The questions about shadows, lights and steps were asked alongside the scale's.
  const [shadows, fire, steps] = await Promise.all([shadowsAsked, fireAsked, stepsAsked]);
  if (fire) {
    shadows.light = { dir: [0, 1], length: 1.5, strength: shadows.light?.strength ?? 0.45, at: fire.at, ...(fire.flame && { flame: true }) };
    log(`light from ${fire.key} at ${fire.at.join(', ')}${fire.flame ? ' (a flame)' : ''}`);
  }
  if (shadows.light && !shadows.light.at) log(`light ${shadows.light.dir.join(', ')} x${shadows.light.length}, strength ${shadows.light.strength} (${shadows.source})`);

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
    ...(steps.length && { steps }),
    flagged,
  };
  return { geometry, grid, blobs, footprint, probes, shadows };
}
