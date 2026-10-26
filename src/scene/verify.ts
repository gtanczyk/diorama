// verify: checks a place's geometry before anyone walks it. An error means the place is not
// playable as is; a flag is something a person should look at, listed in the build report.
// Nothing is flagged and passed silently: every finding is in verify.json with a code.
import type { Geometry } from '../play/geometry.ts';
import { personPx } from '../play/geometry.ts';
import type { Place } from '../world/schema.ts';
import { Grid, reach, roomy } from './walk.ts';

export type Finding = { code: string; key?: string; detail: string };
export type Verdict = { ok: boolean; errors: Finding[]; flags: Finding[] };

/** What masks.json says about each mask. */
export type MaskNotes = {
  things: Record<string, { coarse: boolean; source: string }>;
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

export function verifyPlace(place: Place, g: Geometry, notes: MaskNotes, plates: PlateNotes = {}): Verdict {
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
    if (t.coarse && thing.role !== 'npc') flags.push({ code: 'COARSE_MASK', key: thing.key, detail: `mask is a ${notes.things[thing.key]?.source ?? 'box'}, so it hides no one` });
  }

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

  for (const line of g.flagged ?? []) flags.push({ code: 'DERIVE', detail: line });
  return { ok: errors.length === 0, errors, flags };
}
