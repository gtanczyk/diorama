// occlusion-check: what the depth map will do to people standing on this place's floor, before anyone plays
// it (src/play/depth-occlusion.ts does it at play time). Read by verify: no depth map means only named
// things can hide anyone; floor cells on an upright face put people behind it; a spot where the painting
// covers nearly all of a person means they vanish there.
import type { Geometry } from '../play/geometry.ts';
import { personPx } from '../play/geometry.ts';
import { contactRows, depthAt, frontMask, hiddenShare, MAX_HIDDEN, PERSON_WIDTH } from '../play/depth-occlusion.ts';
import { UPRIGHT_SHARE } from './depthmap.ts';
import type { Depth } from '../play/shadow.ts';
import type { Finding } from './verify.ts';
import { gridOf } from './verify.ts';

/** Every how many walk cells (each way) a person is stood to check. */
const STRIDE = 2;

export type OcclusionCheck = {
  /** Walk cells checked, cells on an upright face (feet over a wall or thin air), cells where the depth map would hide most of a person and so hides nothing. */
  checked: number;
  onFace: Array<[number, number]>;
  unsure: Array<[number, number]>;
  /** Cells where something unmasked (no card) hides part of a person: the depth map's own work. */
  hiddenByUnmasked: number;
};

const boxOf = (pts: Array<[number, number]>): [number, number, number, number] => [
  Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1])),
];

export function checkOcclusion(g: Geometry, d: Depth, owned?: Uint8Array): OcclusionCheck {
  const grid = gridOf(g);
  const out: OcclusionCheck = { checked: 0, onFace: [], unsure: [], hiddenByUnmasked: 0 };
  const contact = contactRows(g, d);
  for (let r = 0; r < grid.rows; r += STRIDE) for (let c = 0; c < grid.cols; c += STRIDE) {
    const i = grid.at(c, r);
    if (!grid.open[i]) continue;
    const [x, y] = grid.centre(i);
    out.checked++;
    const h = personPx(g, y);
    const w = Math.max(4, Math.round(h * PERSON_WIDTH));
    // Upright face: under most of the feet's width the depth hardly changes down the screen (a floor's changes a row
    // per row): the side of a bridge, the wall down to an underpass, a floor mask or a joining path laid on them.
    // A card's thing in front of the feet is left out, and a post or a can in front of one foot is not most of it.
    let face = 0;
    let feet = 0;
    const span = Math.max(16, 0.25 * h);
    for (let fx = x - w / 2; fx <= x + w / 2; fx += 2) {
      const k = Math.min(d.w - 1, Math.max(0, Math.floor(fx / 2))) + Math.min(d.h - 1, Math.floor((y - 1) / 2)) * d.w;
      if (owned?.[k]) continue;
      feet++;
      if ((depthAt(d, fx, y + span / 2) - depthAt(d, fx, y - span / 2)) / span < UPRIGHT_SHARE) face++;
    }
    if (feet && face > 0.6 * feet) out.onFace.push([x, y]);
    if (hiddenShare(g, d, x, y, owned) > MAX_HIDDEN) {
      out.unsure.push([x, y]);
      continue;
    }
    const rect: [number, number, number, number] = [Math.round(x - w / 2), Math.round(y - h), Math.round(x + w / 2), Math.round(y - Math.max(3, h * 0.04))];
    if (frontMask(g, d, rect, x, y, owned)) out.hiddenByUnmasked++;
  }
  return out;
}

/** verify's findings from the check (all flags: the place plays, a person should look). */
export function occlusionFindings(g: Geometry, check: OcclusionCheck | null): Finding[] {
  if (!check) return g.depth ? [] : [{ code: 'NO_DEPTH', detail: 'no depth map: only named things with masks can hide someone; a lamp post or railing nobody named will be drawn behind them' }];
  const out: Finding[] = [];
  // A few cells on a face are the edge of a kerb or a step; many are a floor mask laid on a wall or a bridge's side.
  if (check.onFace.length >= Math.max(10, 0.02 * check.checked)) {
    out.push({ code: 'WALK_ON_FACE', detail: `${check.onFace.length} of ${check.checked} checked floor cells lie on an upright face (a bridge's side, a wall down to a lower floor): feet there are over a wall or thin air. Look at walk.png; floor_cells closes them`, box: boxOf(check.onFace) });
  }
  if (check.unsure.length >= Math.max(10, 0.05 * check.checked)) {
    out.push({ code: 'DEPTH_UNSURE', detail: `${check.unsure.length} of ${check.checked} checked floor cells have over ${Math.round(MAX_HIDDEN * 100)}% of a person in front of them by the depth map (stairs, a slope, or floor where there is none): nothing unmasked hides anyone there`, box: boxOf(check.unsure) });
  }
  return out;
}

/** Reads depth.png and the cards' masks of a place folder (node only), and runs the check. Null without a depth map. */
export async function checkPlaceOcclusion(dir: string, g: Geometry): Promise<OcclusionCheck | null> {
  if (!g.depth) return null;
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { default: sharp } = await import('sharp');
  const { decodeDepth } = await import('../play/shadow.ts');
  const file = path.join(dir, g.depth);
  if (!fs.existsSync(file)) return null;
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const d = decodeDepth(data, info.width, info.height);
  const owned = new Uint8Array(d.w * d.h);
  for (const mask of new Set(g.occluders.map((o) => o.mask).filter((m): m is string => !!m))) {
    const at = path.join(dir, mask);
    if (!fs.existsSync(at)) continue;
    const m = await sharp(at).resize(d.w, d.h, { fit: 'fill' }).greyscale().raw().toBuffer();
    for (let i = 0; i < m.length; i++) if (m[i] > 127) owned[i] = 1;
  }
  return checkOcclusion(g, d, owned);
}
