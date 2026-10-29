// Judges a walk sheet: a walk that tears open (holes in a coat, a boot floating free, an arm off the shoulder) is
// marked, and the runtime slides the painted figure as one piece instead.
import sharp from 'sharp';
import { emptyMask, maskArea, type Mask } from '../image/mask.ts';
import { components } from '../image/raster.ts';
import type { Rig } from '../play/rig.ts';

type Raw = { width: number; height: number; data: Buffer };

const opaque = (r: Raw, min = 128): Mask => {
  const m = emptyMask(r.width, r.height);
  for (let i = 0; i < m.bits.length; i++) m.bits[i] = r.data[i * 4 + 3] >= min ? 1 : 0;
  return m;
};

/** See-through pixels the figure closes round: background pieces that do not reach the picture's edge. */
function holes(fig: Mask): number {
  const bg = emptyMask(fig.width, fig.height);
  fig.bits.forEach((b, i) => (bg.bits[i] = b ? 0 : 1));
  let n = 0;
  for (const c of components(bg)) {
    let edge = false;
    for (let i = 0; i < c.bits.length && !edge; i++) {
      if (!c.bits[i]) continue;
      const x = i % c.width;
      const y = Math.floor(i / c.width);
      edge = x === 0 || y === 0 || x === c.width - 1 || y === c.height - 1;
    }
    if (!edge) n += maskArea(c);
  }
  return n;
}

export type RigCheck = {
  ok: boolean;
  /** Worst walk frame: see-through holes, and pixels in pieces cut off from the body, as shares of the figure. */
  holes: number;
  loose: number;
  /** Why it fails, in a few words. */
  why?: string;
};

/** Holes above this share of the figure, or loose pieces above LOOSE, and the walk is torn. */
export const HOLES = 0.004;
export const LOOSE = 0.002;



/** The same measure on a walk sheet (src/scene/warp.ts): holes and loose pieces in each walk cell. */
export async function checkSheet(rig: Rig, png: Buffer): Promise<RigCheck> {
  const sheet = rig.sheet!;
  const [cw, ch] = sheet.cell;
  let worstHoles = 0;
  let worstLoose = 0;
  const cell = async (f: number) => opaque({ width: cw, height: ch, data: (await sharp(png).extract({ left: (f % sheet.cols) * cw, top: Math.floor(f / sheet.cols) * ch, width: cw, height: ch }).raw().toBuffer()) });
  // Gaps the painting itself closes round (a hand on the hip) are not tears: only what the walk opens counts.
  const painted = holes(await cell(sheet.frames));
  for (let f = 0; f < sheet.frames; f++) {
    const fig = await cell(f);
    const area = maskArea(fig) || 1;
    // Specks of a few pixels (a stray hair) do not count as a loose part.
    const loose = components(fig).slice(1).reduce((s, c) => s + (maskArea(c) > area * 0.0005 ? maskArea(c) : 0), 0);
    worstHoles = Math.max(worstHoles, Math.max(0, holes(fig) - painted) / area);
    worstLoose = Math.max(worstLoose, loose / area);
  }
  const why = [worstHoles > HOLES && `opens holes (${(worstHoles * 100).toFixed(1)}% of the figure)`, worstLoose > LOOSE && `parts come loose (${(worstLoose * 100).toFixed(1)}%)`].filter(Boolean).join(', ');
  return { ok: !why, holes: Math.round(worstHoles * 1e4) / 1e4, loose: Math.round(worstLoose * 1e4) / 1e4, ...(why && { why }) };
}
