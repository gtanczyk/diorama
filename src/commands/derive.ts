// diorama derive <slug> [place...]: geometry.json (walk grid, scale, occluders, spots) and walk.png per place.
import fs from 'node:fs';
import { maskArea, maskFromPng, maskToPng, emptyMask } from '../image/mask.ts';
import { PALETTE, svgLabel, tintOver } from '../image/overlay.ts';
import { Geometry, personPx } from '../play/geometry.ts';
import { defineCommand } from '../registry.ts';
import { placeNpcs, readCorrections } from '../scene/corrections.ts';
import { derive, type ThingIn } from '../scene/derive.ts';
import { depthMap } from '../scene/depthmap.ts';
import { Layout, FRAME } from '../scene/layout.ts';
import { CELL } from '../scene/walk.ts';
import { WorldFiles } from '../world/files.ts';

type MasksJson = { things: Record<string, Omit<ThingIn, 'key' | 'mask'>> };

/** The review picture: walkable cells tinted by floor, footprints red, floor lines, spots and the hero's size. */
async function walkPicture(painting: Buffer, g: Geometry, footprint: ThingIn['mask']): Promise<Buffer> {
  const floors = Math.max(0, ...g.zone!.flatMap((row) => [...row].filter((ch) => ch !== '.').map(Number))) + 1;
  const cells = Array.from({ length: floors }, () => emptyMask(FRAME.width, FRAME.height));
  g.walk.forEach((row, r) => [...row].forEach((ch, c) => {
    if (ch !== '#') return;
    const m = cells[Number(g.zone![r][c])] ?? cells[0];
    for (let y = r * CELL; y < Math.min(FRAME.height, (r + 1) * CELL); y++) m.bits.fill(1, y * FRAME.width + c * CELL, y * FRAME.width + Math.min(FRAME.width, (c + 1) * CELL));
  }));
  const tints = [...cells.map((mask, i) => ({ mask, rgb: PALETTE[(i + 4) % PALETTE.length], alpha: 0.3 })), { mask: footprint, rgb: [255, 40, 40] as [number, number, number], alpha: 0.55 }];
  const svg: string[] = [];
  for (const o of g.occluders) {
    svg.push(`<polyline points="${(o.floor ?? []).map((p) => p.join(',')).join(' ')}" fill="none" stroke="#ffe600" stroke-width="3"/>`);
  }
  for (const t of g.things) {
    svg.push(`<circle cx="${t.stand[0]}" cy="${t.stand[1]}" r="6" fill="#fff" stroke="#000" stroke-width="2"/>`, svgLabel(t.stand[0] + 9, t.stand[1] + 5, t.key));
  }
  // The hero's height at a few depths, as a ruler.
  const rows = g.walk.map((row, r) => (row.includes('#') ? r : -1)).filter((r) => r >= 0);
  for (const q of [0.1, 0.5, 0.95]) {
    const r = rows[Math.floor(q * (rows.length - 1))];
    const c = g.walk[r].indexOf('#') + Math.floor((g.walk[r].lastIndexOf('#') - g.walk[r].indexOf('#')) / 2);
    const [x, y] = [(c + 0.5) * CELL, (r + 0.5) * CELL];
    const h = personPx(g, y);
    svg.push(`<rect x="${x - h * 0.12}" y="${y - h}" width="${h * 0.24}" height="${h}" fill="rgba(80,160,255,0.55)" stroke="#fff" stroke-width="2"/>`);
  }
  // Each step's back edge on stairs, where the feet climb.
  for (const st of g.steps ?? []) svg.push(`<polyline points="${st.top.flatMap((t, i) => (t >= 0 ? [`${st.x0 + i * st.every},${t}`] : [])).join(' ')}" fill="none" stroke="#3cf" stroke-width="3"/>`);
  svg.push(`<circle cx="${g.start[0]}" cy="${g.start[1]}" r="9" fill="#3f6" stroke="#000" stroke-width="2"/>`);
  svg.push(`<line x1="0" y1="${g.scale.horizonY}" x2="${FRAME.width}" y2="${g.scale.horizonY}" stroke="#5af" stroke-width="2" stroke-dasharray="12 8"/>`);
  return tintOver(painting, tints, svg.join(''));
}

defineCommand({
  name: 'derive',
  usage: 'derive <slug> [place...] measure walk grid, scale and occluders from the masks (geometry.json)',
  async run([slug, ...only]) {
    if (!slug) throw new Error('usage: diorama derive <slug> [place...]');
    const files = new WorldFiles(slug);
    const world = files.world();
    const places = world.places.filter((p) => only.length === 0 || only.includes(p.key));
    await Promise.all(places.map(async (place) => {
      const at = (...parts: string[]) => files.place(place.key, ...parts);
      // NPCs are drawn by the runtime, not painted: moving one only moves its box (and where the hero talks to it).
      const layout = placeNpcs(Layout.parse(files.readJson(at('layout.json'))), new Set(place.things.filter((t) => t.role === 'npc').map((t) => t.key)), readCorrections(at()));
      const made = files.readJson(at('masks.json')) as MasksJson;
      const painting = fs.readFileSync(at('painting.png'));
      const things = await Promise.all(Object.entries(made.things).map(async ([key, t]) => ({ ...t, key, mask: await maskFromPng(fs.readFileSync(at('masks', `${key}.png`))) })));
      const floors = await Promise.all(layout.floors.map(async (f) => maskFromPng(fs.readFileSync(at('masks', 'floors', `${f.key}.png`)))));
      const plates = fs.existsSync(at('plates')) ? fs.readdirSync(at('plates')).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)) : [];
      const out = await derive(files.memo, { place, layout, things, floors, painting, plates }, (line) => console.log(`  ${place.key}: ${line}`));
      // Shadows only with a light: without one the runtime has nothing to darken by.
      const lit = out.shadows.light && maskArea(out.shadows.mask) > 0;
      if (lit) files.write(at('masks', 'shadows.png'), await maskToPng(out.shadows.mask));
      else fs.rmSync(at('masks', 'shadows.png'), { force: true });
      // Where the person said the hero should stand to use a thing.
      const fixes = readCorrections(at());
      const placed = out.geometry.things.map((t) => (fixes.things[t.key]?.stand ? { ...t, stand: fixes.things[t.key].stand! } : t));
      const measured = { ...out.geometry, things: placed, ...(out.shadows.light && { light: out.shadows.light }), ...(lit && { shadows: 'masks/shadows.png' }) };
      // Depth for shadows that follow the ground; without it (no fit, no model) they lie flat as before.
      const depth = await depthMap(painting, measured).catch((e: Error) => ({ reason: e.message }));
      if ('png' in depth) {
        files.write(at('depth.png'), depth.png);
        console.log(`  ${place.key}: depth fits the floor on ${Math.round(depth.inliers * 100)}% of ${depth.cells} walk cells`);
      } else {
        fs.rmSync(at('depth.png'), { force: true });
        measured.flagged = [...(measured.flagged ?? []), `depth: ${depth.reason}, shadows stay flat`];
      }
      const geometry = Geometry.parse({ ...measured, ...('png' in depth && { depth: 'depth.png' }) });
      files.write(at('geometry.json'), geometry);
      files.write(at('walk.png'), await walkPicture(painting, geometry, out.footprint));
      const open = geometry.walk.join('').split('#').length - 1;
      console.log(`${place.key}: ${open} walk cells, ${geometry.occluders.length} occluders, person ${Math.round(personPx(geometry, FRAME.height - 20))} px at the front (${geometry.scale.source})`);
    }));
    console.log(`spark calls sent: ${files.memo.sent.spark}`);
  },
});
