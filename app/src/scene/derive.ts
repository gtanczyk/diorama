// derive: the masks become geometry.json, everything the runtime needs to walk a place.
// Walkable = floors and walk-on things, minus things in the way, plus the floor hidden behind a
// standing thing, minus each standing thing's footprint. Then the grid is joined up, the hero's
// size is measured, and every thing gets a spot to stand at.
import { emptyMask, maskArea, type Mask } from '../image/mask.ts';
import { dilate, maskBox, polygonMask, rectMask, subtract, union, unionAll } from '../image/raster.ts';
import type { Memo } from '../meta/memo.ts';
import type { GeoThing, Geometry } from '../play/geometry.ts';
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
export type DeriveIn = { place: Place; layout: Layout; things: ThingIn[]; floors: Mask[]; painting: Buffer; plates?: string[]; carry?: Carry; lastScale?: Scale; previousScale?: Scale;
  /** Where the person wants the hero to begin (hero_start_set): the nearest roomy cell of the main floor. */
  start?: [number, number];
  /** Where the painting stands upright (depthmap.ts uprightTest): no joining path is laid across it. */
  upright?: (x: number, y: number) => boolean;
  /**
   * Floor someone said is floor: brush strokes that add to a floor (the person's, the agent's, the free bridge's)
   * and floor cells the person added. It is walked on whatever thing's mask lies over it.
   */
  said?: Mask;
  /** How tall the hero stands (cast/figures.json), in metres; the scale is for a grown-up. Absent: a grown-up. */
  heroMetres?: number;
  /** The hero as tall as `times` this thing's painted height (corrections heroSize): sets the scale. */
  heroSize?: { like: string; times: number };
  /** Npcs the person stood somewhere (npc_move): they stay there, however small the depth makes them. */
  placedNpcs?: string[] };
export type Derived = { geometry: Geometry; grid: Grid; blobs: Blob[]; footprint: Mask; probes: Sample[]; shadows: Shadows };

const { width: W, height: H } = FRAME;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
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

/**
 * What stands in the way of walking, and what is walked on anyway. A thing's mask blocks the floor, but not where
 * someone brushed floor over it (the free bridge across a rock, the person's stroke up a slope), and not over a
 * smaller walk-on thing inside it: stairs cut into a rock, a jetty running under a boathouse's mask. A thing smaller
 * than the walk-on thing it stands on (a barrel on the jetty) still blocks it.
 */
export function wayClear(things: ThingIn[], blocking: ThingIn[], said: Mask | undefined): { inTheWay: Mask; walkedAnyway: Mask } {
  const walkOns = things.filter((t) => t.kind === 'walk-on').map((t) => ({ mask: t.mask, px: maskArea(t.mask) }));
  const masks = blocking.map((t) => {
    const px = maskArea(t.mask);
    const under = walkOns.filter((w) => w.px > 0 && w.px < px).map((w) => w.mask);
    return under.length ? subtract(t.mask, unionAll(W, H, under)) : t.mask;
  });
  const raw = unionAll(W, H, blocking.map((t) => t.mask));
  let inTheWay = unionAll(W, H, masks);
  if (said) inTheWay = subtract(inTheWay, said);
  // Pixels some thing's mask covers that are walked on all the same: the footprints there are lifted too.
  const walkedAnyway = subtract(raw, inTheWay);
  return { inTheWay, walkedAnyway };
}

export async function derive(memo: Memo, input: DeriveIn, log: (line: string) => void): Promise<Derived> {
  const { place, layout, things, floors, painting, carry } = input;
  const role = new Map(place.things.map((t) => [t.key, t.role]));
  const floorAny = unionAll(W, H, floors);
  const walkOn = unionAll(W, H, things.filter((t) => t.kind === 'walk-on').map((t) => t.mask));
  // A coarse box wider than a third of the picture is a row or a group (mooring posts along a quay, a line of
  // stalls), not one thing to walk round: as a box it would wall the place in two. It stays a thing to click, but
  // only sharp masks and narrower boxes stand in the way.
  // A sharp mask over a quarter of the picture is no prop either: SAM took the quay with the posts on it. Nor is a
  // wide thing found only by its sketch colour (maze walls, a hedge round a yard): its pixels draw its outline, the
  // floors drawn for the place say where to walk.
  const sprawling = (t: ThingIn) => t.kind !== 'walk-on' && t.kind !== 'flat'
    && (((t.coarse || t.source === 'sketch-colour') && (() => { const b = maskBox(t.mask); return !!b && b[2] - b[0] > W / 3; })()) || maskArea(t.mask) > (W * H) / 4);
  const { inTheWay, walkedAnyway } = wayClear(things, things.filter((t) => t.kind !== 'walk-on' && !sprawling(t)), input.said);
  const ground = input.said ? unionAll(W, H, [floorAny, walkOn, input.said]) : union(floorAny, walkOn);
  if (maskArea(walkedAnyway) > 0) log(`${maskArea(walkedAnyway)} px of things' masks walked on anyway (brushed floor, or stairs and walk-on things inside them)`);

  // Standing things (and things on top of nothing) meet the floor; coarse masks still block it.
  const standing = things.filter((t) => (t.kind === 'standing' || t.kind === 'on-top') && !sprawling(t));
  const blobs = standing.flatMap((t) => blobsOf(t.key, t.mask));
  const onFloor = blobs.filter((b) => things.find((t) => t.key === b.thing)!.kind === 'standing');
  // A coarse mask is a box, not a silhouette: nobody walks behind it, and all of it is in the way.
  const isCoarse = (b: Blob) => things.find((t) => t.key === b.thing)!.coarse;
  // No footprint where the floor is walked on anyway: a rock's foot line must not cut the stairs cut into it.
  const footprint = subtract(union(footprintMask(onFloor), unionAll(W, H, onFloor.filter(isCoarse).map((b) => b.mask))), input.said ? union(walkedAnyway, input.said) : walkedAnyway);
  const behind = unionAll(W, H, onFloor.filter((b) => !isCoarse(b)).map((b) => hiddenFloor(b, ground)));
  const walkPx = subtract(union(subtract(ground, inTheWay), behind), footprint);

  const floorOf = (p: number) => floors.findIndex((f) => f.bits[p]);
  let grid = gridFromPixels(walkPx, floorOf, floors.length);
  const flagged: string[] = [];
  const flag = (line: string) => {
    flagged.push(line);
    log(line);
  };
  for (const t of things) if (sprawling(t)) flag(`${t.key}: its mask is too big for one thing (a row, or the floor it stands on), so it does not block the floor`);

  // Join up the floor: closed cells on a painted floor are cheap to open, the layout's floors dearer,
  // things and footprints never.
  const planned = unionAll(W, H, layout.floors.map((f) => polygonMask(W, H, f.outline)));
  const blocked = union(inTheWay, footprint);
  const groundTop = Math.min(...floors.map((f) => maskBox(f)?.[1] ?? H), ...layout.floors.flatMap((f) => f.outline.map(([, y]) => y)));
  const nearFloor = dilate(union(ground, planned), 48);
  let water: Mask | undefined;
  // Cells the gates below shut stay shut: joining the floor up again must not reopen them.
  const shut = new Uint8Array(grid.open.length);
  let wallCost = Infinity;
  const cost = (i: number) => {
    if (shut[i]) return Infinity;
    const [x, y] = grid.centre(i).map(Math.floor);
    const p = Math.min(H - 1, y) * W + Math.min(W - 1, x);
    if (blocked.bits[p] && !behind.bits[p]) return Infinity;
    // Nobody walks on painted water, wherever the layout planned a floor.
    if (water?.bits[p]) return Infinity;
    // A path across the side of a bridge or the wall down to an underpass is thin air: first no path climbs a wall;
    // only a floor no other way reaches is joined up one, at a price, and flagged (verify: WALK_ON_FACE).
    const wall = wallCost && input.upright?.(x, y) ? wallCost : 0;
    // Muse moves floors away from the layout, so the ground between them is fair game too, at a price.
    // A corridor between floors stays near them: no paths cut across a lawn or open water.
    return wall + (ground.bits[p] ? 1 : planned.bits[p] ? 3 : y >= groundTop && nearFloor.bits[p] ? 6 : Infinity);
  };
  // The start is clear of every thing (by about a hero's width), so nobody begins standing in a lamp.
  // Walk-on and flat things (a jetty, a rug) are floor: near them is fine.
  // NPCs are drawn by the game, not painted, so they have no mask: the ground just in front of one is kept clear
  // too, or the hero starts standing over them and hides them in the first frame.
  const npcZones = layout.things.filter((l) => role.get(l.key) === 'npc' && !things.some((t) => t.key === l.key))
    .map((l) => rectMask(W, H, [Math.round(l.x - l.width / 2 - 60), Math.round(l.footY - l.height), Math.round(l.x + l.width / 2 + 60), Math.round(l.footY + 0.6 * l.height)]));
  const nearThings = union(dilate(unionAll(W, H, things.filter((t) => t.kind !== 'walk-on' && t.kind !== 'flat').map((t) => t.mask)), 24), unionAll(W, H, npcZones));
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
    const [sx, sy] = input.start ?? [W / 2, H - 40];
    return nearestRoomy(grid, sx, sy, main) ?? nearestRoomy(grid, sx, sy, clear) ?? nearestRoomy(grid, sx, sy);
  };
  let startCell = startOf();
  if (startCell === undefined) throw new Error(`${place.key}: no walkable floor at all`);
  const walls = input.upright && { open: grid.open.slice(), zone: grid.zone.slice() };
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
  if (joined.stranded.length && input.upright && walls) {
    // A floor no path reaches but up a wall (a plaza above an underpass, a bridge's far bank): joined as it was before
    // walls counted, and flagged, when that reaches more. Verify then names the cells over the wall (WALK_ON_FACE).
    const kept = { open: grid.open.slice(), zone: grid.zone.slice(), joined };
    grid.open.set(walls.open);
    grid.zone.set(walls.zone);
    wallCost = 0;
    const climbed = connect(grid, startCell, cost);
    wallCost = Infinity;
    if (climbed.stranded.length < joined.stranded.length) {
      const over = [...grid.open.keys()].filter((i) => grid.open[i] && !walls.open[i] && input.upright!(...grid.centre(i))).length;
      flag(`no floor joins ${joined.stranded.length - climbed.stranded.length} part(s) of the floor but up a wall: the path opened ${over} cells on it (the hero walks over the wall there); a stair or a floor between them is better`);
      joined = climbed;
    } else {
      grid.open.set(kept.open);
      grid.zone.set(kept.zone);
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
  // The person said how tall the hero is here, against a painted thing: the scale follows it (the horizon stays).
  const heroMetres = input.heroMetres ?? PERSON_M;
  const like = input.heroSize && things.find((t) => t.key === input.heroSize!.like);
  const likeBox = like ? maskBox(like.mask) : undefined;
  if (input.heroSize && !likeBox) flag(`hero size: no thing ${input.heroSize.like} with a mask here; the scale stays`);
  if (input.heroSize && likeBox) {
    const footY = likeBox[3];
    const horizonY = scale.horizonY < footY - 20 ? scale.horizonY : Math.min(layout.horizon, footY - 40, topY - 40);
    const personAt = (input.heroSize.times * (likeBox[3] - likeBox[1]) * PERSON_M) / heroMetres;
    scale = { horizonY, pxPerY: round3(personAt / Math.max(1, footY - horizonY)), source: scale.source };
    log(`scale from the hero's size: ${input.heroSize.times} x ${input.heroSize.like} (${Math.round((likeBox[3] - likeBox[1]) * input.heroSize.times)} px at y ${footY})`);
  }

  // The frame gate: no standing where a good part of the hero would be outside the picture.
  const sized = scale;
  // The gates are for the hero as tall as it is: a small one (a figurine among props) fits where a grown-up would not.
  const heroShare = Math.min(1, heroMetres / PERSON_M);
  let framed = 0;
  grid.open.forEach((v, i) => {
    if (!v) return;
    const [x, y] = grid.centre(i);
    const h = Math.max(8, heroShare * sized.pxPerY * (y - sized.horizonY));
    if (x < 0.1 * h || x > W - 0.1 * h || y < 0.7 * h) {
      grid.open[i] = 0;
      shut[i] = 1;
      framed++;
    }
  });
  // The near gate: in a close-up interior the front rows sit right under the camera, where the hero would be
  // taller than the picture (a bakery at 942 px). Those rows are foreground to look past, not floor to stand on.
  const tooNear = [...grid.open.keys()].filter((i) => grid.open[i] && heroShare * sized.pxPerY * (grid.centre(i)[1] - sized.horizonY) > NEAR_MAX_PX);
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
      const laid: [number, number, number, number] = [l.x - l.width / 2, l.footY - l.height, l.x + l.width / 2, l.footY];
      // An npc the layout set where the painting has no floor (a rival in the sky over a sea painted lower than planned,
      // regatta) is drawn by the game standing on air: it steps onto the nearest floor the hero reaches.
      const onFloor = t.role === 'npc' ? npcOnFloor(laid, grid, reached, sized) : undefined;
      if (onFloor) log(`${t.key}: stood where nothing is walkable (${Math.round(l.x)}, ${Math.round(l.footY)}); moved onto the floor at (${Math.round((onFloor[0] + onFloor[2]) / 2)}, ${Math.round(onFloor[3])})`);
      const standing = onFloor ?? laid;
      // An npc laid out deep in the scene (a dragon at the back of its cave) is drawn a few dozen px tall, a speck
      // the player barely sees (notebook-monsters): it steps forward until a grown-up there is NPC_MIN_PX tall.
      const forward = t.role === 'npc' && !input.placedNpcs?.includes(t.key) ? npcInSight(standing, grid, reached, sized, l.metres) : undefined;
      if (forward) log(`${t.key}: stood far back at (${Math.round((standing[0] + standing[2]) / 2)}, ${Math.round(standing[3])}), where the game draws it tiny; stepped forward to (${Math.round((forward[0] + forward[2]) / 2)}, ${Math.round(forward[3])})`);
      const box = forward ?? standing;
      return { key: t.key, role: t.role, box, stand: spot((box[0] + box[2]) / 2, box[3]), coarse: true };
    }
    const own = blobs.filter((b) => b.thing === t.key);
    const box = maskBox(thing.mask) ?? [0, 0, 0, 0];
    const cx = (box[0] + box[2]) / 2;
    const under = thing.kind === 'on-top' && own[0] ? support(own[0]) : undefined;
    const baseY = under ? under.baseY : own.length ? Math.max(...own.map((b) => b.baseY)) : box[3];
    const stand = thing.kind === 'walk-on' || thing.kind === 'flat' ? spot(cx, (box[1] + box[3]) / 2) : spot(cx, baseY + 14);
    return { key: t.key, role: t.role, kind: thing.kind, box, mask: `masks/${t.key}.png`, stand, ...(thing.coarse && { coarse: true }), ...(input.plates?.includes(t.key) && { plate: `plates/${t.key}.png` }) };
  });
  // Npcs are drawn by the game over the painting: one standing in front of an item or an exit (a scientist
  // before the potion on his table) hides it, and nobody can click it. They step aside along their row, to the
  // nearest reachable spot where they hide little of any.
  type Box = [number, number, number, number];
  const covered = (box: Box, by: GeoThing): number => {
    const t = things.find((m) => m.key === by.key);
    if (!t) return 0;
    const [bx0, by0, bx1, by1] = by.box;
    let [all, hid] = [0, 0];
    for (let y = Math.max(0, Math.floor(by0)); y < Math.min(H, Math.ceil(by1)); y++) for (let x = Math.max(0, Math.floor(bx0)); x < Math.min(W, Math.ceil(bx1)); x++) {
      if (!t.mask.bits[y * W + x]) continue;
      all++;
      if (x >= box[0] && x < box[2] && y >= box[1] && y < box[3]) hid++;
    }
    return all ? hid / all : 0;
  };
  for (const npc of geoThings.filter((t) => t.role === 'npc' && !t.mask)) {
    const foot = npc.box[3];
    const behind = geoThings.filter((t) => (t.role === 'item' || t.role === 'exit') && t.mask && t.box[3] < foot + 4 && t.kind !== 'wall');
    const worst = (box: Box) => Math.max(0, ...behind.map((t) => covered(box, t)));
    if (worst(npc.box) < 0.4) continue;
    const w = npc.box[2] - npc.box[0];
    const cx = (npc.box[0] + npc.box[2]) / 2;
    let moved: Box | undefined;
    for (let d = 16; d <= 480 && !moved; d += 16) for (const x of [cx + d, cx - d]) {
      if (x - w / 2 < 0 || x + w / 2 > W) continue;
      const i = nearestRoomy(grid, x, foot, reached);
      if (i === undefined) continue;
      const [gx, gy] = grid.centre(i);
      if (Math.hypot(gx - x, gy - foot) > 2 * CELL) continue;
      const box: Box = [x - w / 2, npc.box[1], x + w / 2, foot];
      if (worst(box) < 0.15) {
        moved = box;
        break;
      }
    }
    const hidden = behind.filter((t) => covered(npc.box, t) >= 0.4).map((t) => t.key).join(', ');
    if (!moved) {
      flag(`${npc.key}: stands in front of ${hidden} and hides it, with nowhere near to step aside to`);
      continue;
    }
    log(`${npc.key}: steps ${Math.round((moved[0] + moved[2]) / 2 - cx)} px aside so ${hidden} stays in sight`);
    npc.box = moved;
    npc.stand = spot((moved[0] + moved[2]) / 2, foot);
  }
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
    shadows.light = { dir: [0, 1], length: 1.5, strength: shadows.light?.strength ?? 0.45, at: fire.at, ...(fire.flame && { flame: true }), ...(fire.also && { also: fire.also }) };
    log(`light from ${fire.key} at ${fire.at.join(', ')}${fire.flame ? ' (a flame)' : ''}${fire.also ? `, and ${fire.also.length} alike at ${fire.also.map((a) => a.join(', ')).join('; ')}` : ''}`);
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

/** The least a grown-up standing where an npc stands is drawn tall (px): smaller, the npc reads as a speck. */
export const NPC_MIN_PX = Math.round(0.12 * H);

/**
 * An npc's box when it stands so deep in the scene that the game draws it tiny (it sizes everyone by the scale at
 * their feet, whatever box the layout gave them: a 2.8 m dragon 50 px below the horizon came out 59 px tall): moved
 * toward the camera, at the same x, to the reachable roomy cell nearest the depth where a grown-up is NPC_MIN_PX
 * tall. Undefined when it is near enough already or no floor in front of it brings it nearer.
 */
export function npcInSight(box: [number, number, number, number], grid: Grid, reached: Uint8Array, scale: { horizonY: number; pxPerY: number }, metres = PERSON_M, min = NPC_MIN_PX): [number, number, number, number] | undefined {
  const before = box[3] - scale.horizonY;
  if (before <= 0 || scale.pxPerY * before >= min) return undefined;
  const x = (box[0] + box[2]) / 2;
  const i = nearestRoomy(grid, x, scale.horizonY + min / scale.pxPerY, reached);
  if (i === undefined) return undefined;
  const [gx, gy] = grid.centre(i);
  if (gy - scale.horizonY <= 1.05 * before) return undefined;
  // The box is what the game draws there (it is the npc's click and hide area): its height by the scale, its shape kept.
  const h = (metres / PERSON_M) * scale.pxPerY * (gy - scale.horizonY);
  const w = (h * (box[2] - box[0])) / Math.max(1, box[3] - box[1]);
  return [gx - w / 2, gy - h, gx + w / 2, gy];
}

/**
 * An npc's box when its feet are on no floor the hero reaches: moved to the nearest reachable roomy cell, sized for
 * the depth there by the scale; undefined when it already stands on (or within two cells of) such floor.
 */
export function npcOnFloor(box: [number, number, number, number], grid: Grid, reached: Uint8Array, scale: { horizonY: number }): [number, number, number, number] | undefined {
  const x = (box[0] + box[2]) / 2;
  const foot = box[3];
  const i = nearestRoomy(grid, x, foot, reached);
  if (i === undefined) return undefined;
  const [gx, gy] = grid.centre(i);
  if (Math.hypot(gx - x, gy - foot) <= 2 * CELL) return undefined;
  const before = foot - scale.horizonY;
  const after = gy - scale.horizonY;
  const k = before > 0 && after > 0 ? after / before : 1;
  const w = (box[2] - box[0]) * k;
  const h = (box[3] - box[1]) * k;
  return [gx - w / 2, gy - h, gx + w / 2, gy];
}
