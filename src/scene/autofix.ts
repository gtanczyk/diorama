// The first, free tier of repair: fixes a build can make on its own, with no model call, before anyone is
// asked. Each is an ordinary correction (the same ones the fix tools write), so it shows in corrections_get,
// survives rebuilds and can be taken back with corrections_clear. Anything less certain is left to the agent.
import type { Geometry } from '../play/geometry.ts';
import type { Corrections } from './corrections.ts';
import { diagnose } from './diagnose.ts';
import { GRID } from './locate.ts';
import type { Finding } from './verify.ts';
import { gridOf } from './verify.ts';

export type AutoFix = {
  /** What was done, in a line for the report and the agent. */
  what: string;
  /** The step the fix feeds: the place is rebuilt from there. */
  from: 'masks' | 'derive';
  apply(c: Corrections): void;
};

/** A gap longer than this is no slip of a mask: it needs someone to look. */
const MAX_GAP = 3 * GRID;
/** Things the hero walks around, not over: a gap through one is not bridged blindly. */
const SOLID = new Set(['standing', 'wall']);

export function autoFixes(g: Geometry, floorKeys: string[], errors: Finding[]): AutoFix[] {
  const codes = new Set(errors.map((e) => e.code));
  const d = diagnose(g);
  const fixes: AutoFix[] = [];
  if (codes.has('FLOOR_UNREACHABLE') || codes.has('UNREACHABLE')) {
    const grid = gridOf(g);
    for (const p of d.patches) {
      const gap = p.gap;
      if (!gap || gap.px > MAX_GAP || gap.things.some((t) => SOLID.has(t.kind ?? ''))) continue;
      // Brush the reached floor across the gap: a stroke wide enough for the hero (two walk cells and a margin).
      const floor = floorKeys[grid.zone[grid.cellOf(...gap.to)]] ?? floorKeys[p.floors[0]];
      if (!floor) continue;
      const points: [number, number][] = [gap.to, gap.from];
      fixes.push({
        what: `bridged ${p.cells} cells of floor ${p.floors.join('+')} to ${floor} across ${gap.px} px (${gap.cells.join(' ') || 'thin gap'})`,
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
  return fixes;
}
