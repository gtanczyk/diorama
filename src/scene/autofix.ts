// The first, free tier of repair: fixes a build can make on its own, with no model call, before anyone is
// asked. Each is an ordinary correction (the same ones the fix tools write), so it shows in corrections_get,
// survives rebuilds and can be taken back with corrections_clear. Anything less certain is left to the agent.
import type { Geometry } from '../play/geometry.ts';
import type { Mask } from '../image/mask.ts';
import type { Corrections } from './corrections.ts';
import { diagnose } from './diagnose.ts';
import { GRID } from './locate.ts';
import type { Finding } from './verify.ts';
import { gridOf } from './verify.ts';
import { CELL, type Grid, islands, reach, roomy } from './walk.ts';

export type AutoFix = {
  /** What was done, in a line for the report and the agent. */
  what: string;
  /** The step the fix feeds: the place is rebuilt from there. */
  from: 'masks' | 'derive';
  apply(c: Corrections): void;
};

/** A gap longer than this is no slip of a mask: it needs someone to look. */
const MAX_GAP = 3 * GRID;
/** Through stairs or a gangway the painting itself shows the way, so a longer gap is bridged. */
const MAX_GAP_WALK_ON = 6 * GRID;
/** Things the hero walks around, not over: a gap through one is not bridged blindly. */
const SOLID = new Set(['standing', 'wall']);

/** How far a walk-on mask may stop short of a floor and still be taken to join it. */
const JOIN = 16;

/** Walk cells within JOIN px of a mask pixel. */
function nearMask(grid: Grid, m: Mask): Uint8Array {
  const near = new Uint8Array(grid.open.length);
  const reachCells = Math.ceil(JOIN / CELL);
  for (let y = 0; y < m.height; y += 2) {
    for (let x = 0; x < m.width; x += 2) {
      if (!m.bits[y * m.width + x]) continue;
      const c0 = Math.floor(x / CELL);
      const r0 = Math.floor(y / CELL);
      for (let r = r0 - reachCells; r <= r0 + reachCells; r++) {
        for (let c = c0 - reachCells; c <= c0 + reachCells; c++) if (grid.inside(c, r)) near[grid.at(c, r)] = 1;
      }
    }
  }
  return near;
}

/**
 * masks: the walk-on things' masks by key. Stairs only carry a bridge when their mask reaches both the patch
 * and the reached floor: stairs that climb from the far side to somewhere else (water between the floors)
 * join nothing, and a stroke across them would have the hero walk on water.
 */
export function autoFixes(g: Geometry, floorKeys: string[], errors: Finding[], masks: Record<string, Mask> = {}): AutoFix[] {
  const codes = new Set(errors.map((e) => e.code));
  const d = diagnose(g);
  const fixes: AutoFix[] = [];
  if (codes.has('FLOOR_UNREACHABLE') || codes.has('UNREACHABLE')) {
    const grid = gridOf(g);
    const cells = roomy(grid);
    const reached = reach(grid, grid.cellOf(...g.start), cells);
    const parts = islands(grid, cells);
    const joins = (key: string, patch: number[]) => {
      const m = masks[key];
      if (!m) return false;
      const near = nearMask(grid, m);
      return patch.some((i) => near[i]) && [...reached.keys()].some((i) => reached[i] && near[i]);
    };
    for (const p of d.patches) {
      const gap = p.gap;
      if (!gap || gap.things.some((t) => SOLID.has(t.kind ?? ''))) continue;
      // Stairs or a gangway (a walk-on thing) standing in the gap are what joins the two levels: bridge along
      // them even when the gap is long, but only when their mask touches both sides. Without one, a long gap is
      // a real wall (or water) and needs someone to look: a repaint or a floor in the layout.
      const patch = parts.find((x) => x.includes(grid.cellOf(...gap.from))) ?? [];
      const walkOn = gap.things.filter((t) => t.kind === 'walk-on' && joins(t.key, patch));
      const along = walkOn.length > 0;
      if (gap.px > (along ? MAX_GAP_WALK_ON : MAX_GAP)) continue;
      // Brush the reached floor across the gap: a stroke wide enough for the hero (two walk cells and a margin).
      const floor = floorKeys[grid.zone[grid.cellOf(...gap.to)]] ?? floorKeys[p.floors[0]];
      if (!floor) continue;
      const points: [number, number][] = [gap.to, gap.from];
      fixes.push({
        what: `bridged ${p.cells} cells of floor ${p.floors.join('+') || 'none'} to ${floor} across ${gap.px} px (${gap.cells.join(' ') || 'thin gap'})${along ? ` along ${walkOn.map((t) => t.key).join(', ')}` : ''}`,
        from: 'masks',
        apply: (c) => {
          const f = (c.floors[floor] ??= { add: [], remove: [], strokes: [] });
          // The same bridge twice is no new fix: a build that tried it once leaves it to the agent.
          if (!f.strokes.some((s) => JSON.stringify(s.points) === JSON.stringify(points))) f.strokes.push({ mode: 'add', radius: 14, points });
        },
      });
    }
  }
  if (codes.has('SPOT_UNREACHABLE')) {
    const wanted = new Set(errors.filter((e) => e.code === 'SPOT_UNREACHABLE').map((e) => e.key));
    for (const s of d.spots) {
      if (!wanted.has(s.thing) || !s.nearest) continue;
      const at = s.nearest;
      fixes.push({ what: `moved the stand spot of ${s.thing} to (${at.join(', ')}), the nearest reachable floor`, from: 'derive', apply: (c) => void ((c.things[s.thing] ??= { strokes: [] }).stand = at) });
    }
  }
  // Spark found the thing in another box: give SAM that box (one SAM call when the place is rebuilt).
  for (const e of errors.filter((x) => x.code === 'MASK_WRONG' && x.key)) {
    const box = e.box;
    if (!box) continue;
    fixes.push({ what: `gave SAM the box Spark sees ${e.key} in: [${box.join(', ')}]`, from: 'masks', apply: (c) => void ((c.things[e.key!] ??= { strokes: [] }).box = box) });
  }
  return fixes;
}
