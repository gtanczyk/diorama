// The explorer: puts the hero on every part of the floor in the real play page and checks each
// frame for what players notice: standing inside things, drawn over things he is behind, hidden
// by things he is in front of, cut off by the frame. Spark looks at a contact sheet of the worst.
import sharp from 'sharp';
import { z } from 'zod';
import { emptyMask } from '../image/mask.ts';
import { PALETTE, svgLabel, tintOver } from '../image/overlay.ts';
import type { Memo } from '../meta/memo.ts';
import { askSparkJson } from '../meta/spark.ts';
import type { Geometry } from '../play/geometry.ts';
import { gridOf } from '../scene/verify.ts';
import { reach, roomy } from '../scene/walk.ts';
import type { ProbeHit } from './probe.ts';

export const ISSUES = ['feet-inside', 'drawn-over', 'over-box', 'hidden-in-front', 'clipped', 'invisible'] as const;
export type Issue = (typeof ISSUES)[number];
export type Checked = ProbeHit & { issues: Issue[]; worst?: string };

/** Up to `max` spots on walkable cells, on a coarser lattice for bigger floors, plus every thing's spot. */
export function positions(g: Geometry, max = 600): [number, number][] {
  const grid = gridOf(g);
  const open = [...grid.open.keys()].filter((i) => grid.open[i]);
  let step = 2;
  while (open.length / (step * step) > max && step < 16) step++;
  const out: [number, number][] = [];
  for (const i of open) {
    const c = i % grid.cols;
    const r = Math.floor(i / grid.cols);
    if (c % step === 0 && r % step === 0) out.push(grid.centre(i));
  }
  for (const t of g.things) out.push(t.stand);
  return out;
}

/** The code checks: which issues a probe shows. Thresholds keep a few stray pixels from counting. */
export function classify(hit: ProbeHit): Checked {
  const issues: Issue[] = [];
  const some = (n: number) => n >= Math.max(40, hit.drawn * 0.01);
  const over = Object.entries(hit.overNearer).filter(([, n]) => some(n));
  const hidden = Object.entries(hit.hiddenByFarther).filter(([, n]) => n >= Math.max(150, hit.drawn * 0.01));
  if (hit.feetIn.length) issues.push('feet-inside');
  if (over.length || some(hit.overDepth ?? 0)) issues.push('drawn-over');
  // A box-only thing can't hide him, so standing where its box would overlap him looks wrong either way.
  const boxed = Object.entries(hit.overBox ?? {}).filter(([, n]) => some(n));
  if (boxed.length) issues.push('over-box');
  if (hidden.length) issues.push('hidden-in-front');
  if (hit.off > 0.3) issues.push('clipped');
  if (hit.drawn > 0 && hit.hidden > 0.85 * hit.drawn) issues.push('invisible');
  const worst = hit.feetIn[0] ?? over.sort((a, b) => b[1] - a[1])[0]?.[0] ?? (some(hit.overDepth ?? 0) ? 'depth' : undefined) ?? boxed.sort((a, b) => b[1] - a[1])[0]?.[0] ?? hidden.sort((a, b) => b[1] - a[1])[0]?.[0];
  return { ...hit, issues, ...(worst && { worst }) };
}

/** Painting with each probed spot as a dot: green clean, red with issues, labelled by the thing involved. */
export async function heatmap(painting: Buffer, g: Geometry, checked: Checked[]): Promise<Buffer> {
  const walk = emptyMask(g.frame.width, g.frame.height);
  g.walk.forEach((row, r) => [...row].forEach((ch, c) => {
    if (ch !== '#') return;
    for (let y = r * g.cell; y < Math.min(g.frame.height, (r + 1) * g.cell); y++) walk.bits.fill(1, y * g.frame.width + c * g.cell, y * g.frame.width + Math.min(g.frame.width, (c + 1) * g.cell));
  }));
  const dots = checked.map((h) => `<circle cx="${h.x}" cy="${h.y}" r="${h.issues.length ? 6 : 3}" fill="${h.issues.length ? '#ff3030' : '#30ff70'}" stroke="#000" stroke-width="1"/>`);
  const labelled = new Set<string>();
  const labels = checked.filter((h) => h.worst && !labelled.has(h.worst) && labelled.add(h.worst)).map((h) => svgLabel(h.x + 8, h.y - 6, `${h.issues[0]}: ${h.worst}`, [255, 120, 120]));
  return tintOver(painting, [{ mask: walk, rgb: PALETTE[4], alpha: 0.18 }], [...dots, ...labels].join(''));
}

/** A 4x4 sheet of numbered crops. */
export async function contactSheet(crops: Buffer[], size: number): Promise<Buffer> {
  const cols = 4;
  const rows = Math.ceil(crops.length / cols);
  const tiles = await Promise.all(crops.map(async (crop, i) => ({
    input: await sharp(crop).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="none" stroke="#000" stroke-width="4"/>${svgLabel(8, 24, `#${i + 1}`, [255, 230, 0])}</svg>`) }]).png().toBuffer(),
    left: (i % cols) * size,
    top: Math.floor(i / cols) * size,
  })));
  return sharp({ create: { width: cols * size, height: rows * size, channels: 3, background: '#111' } }).composite(tiles).png().toBuffer();
}

const Judged = z.object({ wrong: z.array(z.object({ id: z.number(), why: z.string() })) });

export async function judge(memo: Memo, label: string, sheet: Buffer, count: number): Promise<z.infer<typeof Judged>['wrong']> {
  const prompt = `This contact sheet shows ${count} tiles from a 2D point-and-click adventure, each a crop around the player character (a simple dark figure), numbered #1 to #${count} in the corner. Which tiles look wrong, and why? Look for: the character standing inside an object, partly hidden by an object they should be in front of, drawn over an object they should be behind, floating above or sunk into the ground, or the wrong size for the things around them.
Reply with JSON only: {"wrong": [{"id": 1, "why": "short reason"}]}, an empty list when all look right.`;
  const { wrong } = Judged.parse(await askSparkJson(memo, { schema: Judged, label, prompt, images: [sheet] }));
  return wrong.filter((w) => w.id >= 1 && w.id <= count);
}

/**
 * Closes cells around spots with issues, never near the start or a thing's spot, and never more
 * than `cap` of a floor's cells; a fix that would cut any floor off from the start is undone.
 */
export function fixGrid(g: Geometry, checked: Checked[], cap = 0.35): { geometry: Geometry; closed: number; undone: string[] } {
  const grid = gridOf(g);
  const keep = new Set<number>();
  for (const [x, y] of [g.start, ...g.things.map((t) => t.stand)]) {
    const c0 = Math.floor(x / g.cell);
    const r0 = Math.floor(y / g.cell);
    for (let r = r0 - 3; r <= r0 + 3; r++) for (let c = c0 - 3; c <= c0 + 3; c++) if (grid.inside(c, r)) keep.add(grid.at(c, r));
  }
  const byZone = new Map<number, number[]>();
  for (const h of checked) {
    if (!h.issues.some((i) => i !== 'invisible')) continue;
    const c0 = Math.floor(h.x / g.cell);
    const r0 = Math.floor(h.y / g.cell);
    for (let r = r0 - 1; r <= r0 + 1; r++) {
      for (let c = c0 - 1; c <= c0 + 1; c++) {
        if (!grid.inside(c, r)) continue;
        const i = grid.at(c, r);
        if (!grid.open[i] || keep.has(i)) continue;
        byZone.set(grid.zone[i], [...(byZone.get(grid.zone[i]) ?? []), i]);
      }
    }
  }
  const undone: string[] = [];
  let closed = 0;
  const startCell = grid.cellOf(...g.start);
  for (const [zone, cells] of byZone) {
    const unique = [...new Set(cells)];
    const size = grid.zone.filter((z, i) => z === zone && grid.open[i]).length;
    if (unique.length > cap * size) {
      undone.push(`floor ${zone}: fixing would close ${unique.length} of ${size} cells`);
      continue;
    }
    unique.forEach((i) => (grid.open[i] = 0));
    const reached = reach(grid, startCell, roomy(grid));
    const stillThere = [...grid.zone.keys()].some((i) => grid.zone[i] === zone && reached[i]);
    const spotsOk = g.things.every((t) => reached[grid.cellOf(...t.stand)] || !reach(gridOf(g), startCell)[grid.cellOf(...t.stand)]);
    if (!stillThere || !spotsOk) {
      unique.forEach((i) => (grid.open[i] = 1));
      undone.push(`floor ${zone}: fixing would cut it or a thing's spot off`);
      continue;
    }
    closed += unique.length;
  }
  const { walk } = grid.rowsOut();
  return { geometry: { ...g, walk }, closed, undone };
}
