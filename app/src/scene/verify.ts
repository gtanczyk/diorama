// verify: checks a place's geometry before anyone walks it. An error means the place is not
// playable as is; a flag is something a person should look at, listed in the build report.
// Nothing is flagged and passed silently: every finding is in verify.json with a code.
import type { Geometry } from '../play/geometry.ts';
import { personPx } from '../play/geometry.ts';
import type { Place } from '../world/schema.ts';
import { Grid, reach, roomy } from './walk.ts';
import { rectIou } from '../image/raster.ts';

export type Finding = { code: string; key?: string; detail: string; /** Where the thing really is, when a check found it elsewhere. */ box?: [number, number, number, number] };
export type Verdict = { ok: boolean; errors: Finding[]; flags: Finding[] };

/** What masks.json says about each mask. */
export type MaskNotes = {
  things: Record<string, { coarse: boolean; source: string; check?: { ok: boolean; seen?: string; box?: [number, number, number, number] | null } }>;
  floors: Record<string, { coarse: boolean; source: string; iouLayout: number }>;
};

export function gridOf(g: Pick<Geometry, 'walk' | 'zone'>): Grid {
  const grid = new Grid(Math.max(...g.walk.map((r) => r.length)), g.walk.length);
  g.walk.forEach((row, r) => [...row].forEach((ch, c) => {
    const i = grid.at(c, r);
    grid.open[i] = ch === '#' ? 1 : 0;
    const z = g.zone?.[r]?.[c];
    grid.zone[i] = z && z !== '.' ? Number(z) : -1;
  }));
  return grid;
}

/** plates.json: whether SAM still finds the thing on its plate. */
export type PlateNotes = Record<string, { stillThere: boolean }>;

/** backdrop.json: per card, whether its outline cuts through a painted part of its thing. */
export type BackdropNotes = Record<string, { cut?: { px: number; box: [number, number, number, number] | null } }>;

const words = (text: string) => text.toLowerCase().match(/[a-z]{3,}/g)?.map((w) => w.replace(/(es|s)$/, '')) ?? [];

/** What a thing is, in a word or two: its key's words and the head noun of its looks ("a chestnut horse in its stall" -> horse). */
function kindWords(key: string, looks = ''): Set<string> {
  const head = looks.toLowerCase().split(/\b(?:with|in|on|of|at|by|that|which|under|over|near|beside)\b|[,;(]/)[0];
  return new Set([...words(key.replace(/[-_]/g, ' ')), ...words(head).slice(-1)]);
}

/** Does Spark's word for what it sees name the same kind of thing? */
export function sameKind(seen: string, key: string, looks?: string): boolean {
  const kind = kindWords(key, looks);
  // What Spark says is not there does not count: "the hull of a rowboat, no can in its mask" saw no can.
  const said = seen.replace(/\b(?:no|not|without|nor|missing)\s+(?:a|an|the|any)?\s*[a-z-]+/gi, ' ');
  return words(said).some((w) => kind.has(w));
}

export function verifyPlace(place: Place, g: Geometry, notes: MaskNotes, plates: PlateNotes = {}, backdrop: BackdropNotes = {}): Verdict {
  const errors: Finding[] = [];
  const flags: Finding[] = [];
  const grid = gridOf(g);
  const cells = roomy(grid);
  const open = grid.count();
  const cell = (x: number, y: number) => grid.cellOf(x, y);

  if (open < 200) errors.push({ code: 'NO_FLOOR', detail: `only ${open} walkable cells` });
  const start = cell(...g.start);
  if (!cells[start]) errors.push({ code: 'START_BLOCKED', detail: `start (${g.start.join(', ')}) is not on open floor` });
  const reached = reach(grid, start, cells);
  // Thin fringes next to reached floor are fine; a whole patch out of reach is not.
  const cut = [...cells.keys()].filter((i) => cells[i] && !reached[i]).length;
  if (cut >= 20) errors.push({ code: 'UNREACHABLE', detail: `${cut} walkable cells can't be reached from the start` });

  // Every floor that has cells is reachable.
  const zones = new Set<number>();
  grid.zone.forEach((z, i) => grid.open[i] && z >= 0 && zones.add(z));
  for (const z of zones) {
    const any = [...grid.zone.keys()].some((i) => grid.zone[i] === z && reached[i]);
    if (!any) errors.push({ code: 'FLOOR_UNREACHABLE', key: String(z), detail: `floor ${z} has walkable cells but none reachable` });
  }

  for (const thing of place.things) {
    const t = g.things.find((x) => x.key === thing.key);
    if (!t) {
      errors.push({ code: 'THING_MISSING', key: thing.key, detail: 'not in geometry.json' });
      continue;
    }
    if (thing.role !== 'npc' && !t.mask) errors.push({ code: 'MASK_MISSING', key: thing.key, detail: 'painted thing without a mask' });
    const at = cell(...t.stand);
    if (!reached[at]) {
      const finding = { code: 'SPOT_UNREACHABLE', key: thing.key, detail: `its spot (${t.stand.map(Math.round).join(', ')}) can't be reached` };
      // A prop can stay a thing to look at; exits, items and people must be usable.
      (thing.role === 'prop' ? flags : errors).push(finding);
    }
    const check = notes.things[thing.key]?.check;
    if (check && !check.ok) {
      const seen = check.seen ?? 'something else';
      // Spark points to where the thing really is, and it is where the mask is, and what it sees there is that kind
      // of thing: a doubt about details ("but no long rays in its mask", when the painting has none), not a wrong
      // mask. Brushing a disc of sky onto the mask to please it only gave the thing a round outline.
      if (check.box && check.seen && rectIou(check.box, t.box) >= 0.6 && sameKind(check.seen, thing.key, thing.looks)) flags.push({ code: 'MASK_DOUBT', key: thing.key, detail: `Spark sees ${seen} in its mask, where the mask is` });
      // Spark points to where the thing really is: the mask is wrong for sure, whatever the thing's role.
      else if (check.box) errors.push({ code: 'MASK_WRONG', key: thing.key, detail: `Spark sees ${seen} in its mask; it is at [${check.box.join(', ')}]`, box: check.box });
      // Spark sees no such thing anywhere, and what it sees is not even the same kind of thing: it was never
      // painted. A doubt about details ("a bronze bell" for "a small brass bell") stays a flag to look at.
      else if (check.seen && !sameKind(check.seen, thing.key, thing.looks)) errors.push({ code: 'THING_NOT_PAINTED', key: thing.key, detail: `Spark sees ${seen} where it should be, and no ${thing.key} anywhere` });
      else flags.push({ code: 'MASK_DOUBT', key: thing.key, detail: `Spark sees ${seen} in its mask` });
    }
    if (notes.things[thing.key]?.source === 'colour-cut') flags.push({ code: 'COLOUR_CUT', key: thing.key, detail: 'SAM missed it; its mask was cut out of its box by colour' });
    if (notes.things[thing.key]?.source === 'sketch-colour') flags.push({ code: 'COLOUR_CUT', key: thing.key, detail: 'SAM missed it; its mask is the pixels of its sketch colour in its box' });
    if (t.coarse && thing.role !== 'npc') flags.push({ code: 'COARSE_MASK', key: thing.key, detail: `mask is a ${notes.things[thing.key]?.source ?? 'box'}, so it hides no one` });
  }

  // A floor painted nowhere near its layout that the hero cannot walk on at all: the painting left the plan (stairs
  // or a trail drawn somewhere else, or not drawn as floor), and whatever exit leads off it is only a click at an edge.
  Object.entries(notes.floors).forEach(([key, f], z) => {
    if (!g.zone || f.coarse || f.iouLayout >= 0.05) return;
    if ([...grid.zone.keys()].some((i) => grid.zone[i] === z && reached[i])) return;
    // When every exit, item and person can still be reached, the lost floor costs the game nothing (a boat's deck
    // the hero never needs to step into): a flag to look at, not a reason the place cannot be played.
    const needed = g.things.filter((t) => t.role === 'exit' || t.role === 'item' || t.role === 'npc');
    const spare = needed.length > 0 && needed.every((t) => reached[cell(...t.stand)]);
    (spare ? flags : errors).push({ code: 'FLOOR_LOST', key, detail: `painted floor overlaps its layout only ${f.iouLayout.toFixed(2)} and none of it can be walked on${spare ? '; every exit, item and person is reached without it' : ''}` });
  });
  for (const [key, f] of Object.entries(notes.floors)) {
    if (f.coarse) flags.push({ code: 'FLOOR_COARSE', key, detail: `floor taken from ${f.source}` });
    else if (f.iouLayout < 0.3) flags.push({ code: 'FLOOR_MOVED', key, detail: `painted floor overlaps its layout only ${f.iouLayout.toFixed(2)} (the painting wins)` });
  }

  // Scale: the horizon above every floor, the hero neither a dot at the back nor a giant at the front.
  const rows = g.walk.map((row, r) => (row.includes('#') ? r : -1)).filter((r) => r >= 0);
  if (rows.length) {
    const topY = rows[0] * g.cell;
    const bottomY = (rows[rows.length - 1] + 1) * g.cell;
    if (g.scale.horizonY >= topY) errors.push({ code: 'HORIZON_LOW', detail: `horizon ${g.scale.horizonY} is not above the floor top ${topY}` });
    const near = personPx(g, bottomY);
    const far = personPx(g, topY + g.cell);
    if (near < 60 || near > 760) errors.push({ code: 'SCALE_NEAR', detail: `a person at the front is ${Math.round(near)} px tall` });
    if (far < 14) errors.push({ code: 'SCALE_FAR', detail: `a person at the back is ${Math.round(far)} px tall` });
    if (g.scale.source !== 'spark') flags.push({ code: 'SCALE_FALLBACK', detail: `scale from ${g.scale.source}` });
    // Where his head would leave the frame.
    let clipped = 0;
    grid.open.forEach((v, i) => {
      if (!v) return;
      const [, y] = grid.centre(i);
      if (y - personPx(g, y) < -0.3 * personPx(g, y)) clipped++;
    });
    if (clipped > 0.05 * open) flags.push({ code: 'HEAD_OFF_FRAME', detail: `${clipped} cells put over 30% of the hero above the frame` });
  }

  for (const [key, p] of Object.entries(plates)) {
    if (p.stillThere) flags.push({ code: 'PLATE_NOT_CLEAN', key, detail: 'SAM still finds it on its plate; taking it may leave it painted' });
  }

  // With parallax a card slides against the backdrop: a part its mask left out stays behind and splits off.
  for (const [key, b] of Object.entries(backdrop)) {
    if (b.cut) flags.push({ code: 'CARD_CUT', key, detail: `its mask leaves out a painted part of it (${b.cut.px} px of its outline cut through it), which stays on the backdrop when the card slides; mask it again with a box around the whole thing`, ...(b.cut.box && { box: b.cut.box }) });
  }

  for (const line of g.flagged ?? []) flags.push({ code: 'DERIVE', detail: line });
  return { ok: errors.length === 0, errors, flags };
}
