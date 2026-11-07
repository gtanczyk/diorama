// diorama derive <slug> [place...]: geometry.json (walk grid, scale, occluders, spots) and walk.png per place.
import fs from 'node:fs';
import { maskArea, maskFromPng, maskToPng, emptyMask } from '../image/mask.ts';
import { PALETTE, svgLabel, tintOver } from '../image/overlay.ts';
import { Geometry, personPx } from '../play/geometry.ts';
import { defineCommand } from '../registry.ts';
import { brush, placeNpcs, readCorrections, type Corrections } from '../scene/corrections.ts';
import { cellsMask } from '../scene/locate.ts';
import { derive, type ThingIn } from '../scene/derive.ts';
import { depthMap, uprightTest } from '../scene/depthmap.ts';
import { paintedGlows } from '../scene/glows.ts';
import { carryFrom, ran, tilesLine } from '../scene/carry.ts';
import { Layout, FRAME } from '../scene/layout.ts';
import { CELL, nearestRoomy, reach, roomy } from '../scene/walk.ts';
import { closeFaces, placeDepth } from '../scene/occlusion-check.ts';
import { gridOf } from '../scene/verify.ts';
import { unionAll } from '../image/raster.ts';
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
  // Each painted thing is named on itself (over the top of its box), and the spot the hero walks to for it is a
  // small dot joined to it by a thin line: names piled up where the hero stands read as things in the wrong place.
  for (const t of g.things) {
    if (t.role === 'npc' || !t.box) {
      svg.push(`<circle cx="${t.stand[0]}" cy="${t.stand[1]}" r="6" fill="#fff" stroke="#000" stroke-width="2"/>`, svgLabel(t.stand[0] + 9, t.stand[1] + 5, t.role === 'npc' ? `${t.key} stands here (not painted)` : t.key));
      continue;
    }
    const [x0, y0, x1, y1] = t.box;
    const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
    const lx = Math.max(4, Math.min(FRAME.width - 8 * t.key.length - 12, cx - 4 * t.key.length));
    const ly = y0 > 30 ? y0 - 8 : Math.min(FRAME.height - 8, y0 + 22);
    svg.push(
      `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="none" stroke="#fff" stroke-opacity="0.55" stroke-width="2" stroke-dasharray="6 5"/>`,
      `<line x1="${t.stand[0]}" y1="${t.stand[1]}" x2="${cx}" y2="${cy}" stroke="#fff" stroke-opacity="0.7" stroke-width="1.5"/>`,
      `<circle cx="${t.stand[0]}" cy="${t.stand[1]}" r="4" fill="#fff" stroke="#000" stroke-width="1.5"/>`,
      svgLabel(lx, ly, t.key),
    );
  }
  // The hero's size at three depths, as little figures spread over the floor (far left, middle, near right):
  // stacked boxes in one column read as a path, not as a person.
  const rows = g.walk.map((row, r) => (row.includes('#') ? r : -1)).filter((r) => r >= 0);
  // No walkable row at all (NO_FLOOR): no figures to draw; verify reports the missing floor.
  for (const [q, across] of rows.length ? ([[0.1, 0.2], [0.5, 0.5], [0.95, 0.8]] as const) : []) {
    const r = rows[Math.floor(q * (rows.length - 1))];
    const cols = [...g.walk[r]].flatMap((ch, c) => (ch === '#' ? [c] : []));
    // The walkable cell nearest to a quarter, the middle and three quarters of the frame, so they stand apart.
    const want = (across * FRAME.width) / CELL;
    const c = cols.reduce((best, col) => (Math.abs(col - want) < Math.abs(best - want) ? col : best));
    const [x, y] = [(c + 0.5) * CELL, (r + 0.5) * CELL];
    const h = personPx(g, y);
    const head = h * 0.065;
    svg.unshift(`<g fill="rgba(80,160,255,0.6)" stroke="#fff" stroke-width="2"><circle cx="${x}" cy="${y - h + head}" r="${head}"/><rect x="${x - h * 0.1}" y="${y - h + head * 2.2}" width="${h * 0.2}" height="${h - head * 2.2}" rx="${h * 0.05}"/></g>`);
    if (q === 0.95) svg.push(svgLabel(x - h * 0.1, y - h - 8, 'hero size'));
  }
  // Each step's back edge on stairs, where the feet climb.
  for (const st of g.steps ?? []) svg.push(`<polyline points="${st.top.flatMap((t, i) => (t >= 0 ? [`${st.x0 + i * st.every},${t}`] : [])).join(' ')}" fill="none" stroke="#3cf" stroke-width="3"/>`);
  svg.push(`<circle cx="${g.start[0]}" cy="${g.start[1]}" r="9" fill="#3f6" stroke="#000" stroke-width="2"/>`, svgLabel(g.start[0] + 12, g.start[1] + 5, 'start'));
  svg.push(`<line x1="0" y1="${g.scale.horizonY}" x2="${FRAME.width}" y2="${g.scale.horizonY}" stroke="#5af" stroke-width="2" stroke-dasharray="12 8"/>`, svgLabel(8, g.scale.horizonY - 6, 'horizon'));
  return tintOver(painting, tints, svg.join(''));
}

/**
 * The floor someone said is floor: each floor's strokes that add (the person's, the agent's, the free bridge's)
 * and the cells the person added. Erase strokes after them take back what they cover.
 */
export function saidFloor(c: Corrections): ThingIn['mask'] | undefined {
  const floors = Object.values(c.floors);
  const strokes = floors.flatMap((f) => f.strokes);
  const cells = floors.flatMap((f) => f.add);
  if (!cells.length && !strokes.some((s) => s.mode === 'add')) return undefined;
  const said = brush(cells.length ? cellsMask(cells) : emptyMask(FRAME.width, FRAME.height), strokes);
  return maskArea(said) ? said : undefined;
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
      const carry = await carryFrom(at(), 'derive', painting);
      if (carry) console.log(`  ${place.key}: ${tilesLine(carry)}; questions it does not reach keep their answers`);
      const before = fs.existsSync(at('geometry.json')) ? Geometry.safeParse(files.readJson(at('geometry.json'))).data?.scale : undefined;
      const previousScale = before && { ...before, source: before.source ?? ('spark' as const) };
      const lastScale = carry ? previousScale : undefined;
      const start = readCorrections(at()).start;
      const said = saidFloor(readCorrections(at()));
      // The lights as painted: the layout's points are guesses made before the painting (a lighthouse lamp drawn
      // 170 px above its point). The runtime glows sit on them, and the lamp that lights the ground is found by them.
      const holders = things.filter((t) => t.kind !== 'walk-on' && t.kind !== 'flat').map((t) => t.mask);
      const glows = await paintedGlows(painting, layout.lights, holders);
      if (glows.line) console.log(`  ${place.key}: ${glows.line}`);
      const asPainted = { ...layout, lights: glows.glows.map((g) => ({ ...layout.lights.find((l) => l.key === g.key)!, x: g.x, y: g.y })) };
      // Upright surfaces from the depth model: no path joining the floors climbs a wall. Without the model, none.
      const upright = await uprightTest(painting, unionAll(FRAME.width, FRAME.height, floors)).catch((e: Error) => {
        console.log(`  ${place.key}: no depth model for walls (${e.message})`);
        return undefined;
      });
      const out = await derive(files.memo, { place, layout: asPainted, things, floors, painting, plates, carry, lastScale, previousScale, ...(start && { start }), ...(upright && { upright }), ...(said && { said }) }, (line) => console.log(`  ${place.key}: ${line}`));
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
      const geometry = Geometry.parse({ ...measured, ...('png' in depth && { depth: 'depth.png' }), ...(layout.lights.length && { glows: glows.glows }) });
      // Walk cells on an upright face (the front of a bridge's planks) close, with the floor only they led to.
      const read = await placeDepth(at(), geometry);
      const faced = read && closeFaces(geometry, read.d, read.owned);
      if (faced) {
        Object.assign(geometry, { walk: faced.walk, zone: faced.zone, start: faced.start });
        // A stand the closing left out of reach (on the face, or on a fringe too narrow to walk) moves to the nearest
        // floor the start reaches.
        const grid = gridOf(geometry);
        const reached = reach(grid, grid.cellOf(...geometry.start), roomy(grid));
        geometry.things = geometry.things.map((t) => {
          if (reached[grid.cellOf(...t.stand)]) return t;
          const i = nearestRoomy(grid, ...t.stand, reached);
          return i === undefined ? t : { ...t, stand: grid.centre(i) };
        });
        console.log(`  ${place.key}: closed ${faced.closed} walk cells on an upright face (feet over thin air)${faced.beyond ? ` and ${faced.beyond} only they led to` : ''}`);
      }
      if (place.kind === 'drive') {
        // A drive's scenery streams past, so everything one clicks stays put as a card of its own (a road sign
        // left in the scenery would slide away from where it is clicked).
        const carded = new Set(geometry.occluders.map((o) => o.thing ?? o.key));
        for (const t of geometry.things) {
          if (carded.has(t.key) || !t.mask || t.role === 'npc') continue;
          geometry.occluders.push({ key: `${t.key}#1`, thing: t.key, box: t.box, mask: t.mask, baseY: t.box[3] });
        }
      }
      files.write(at('geometry.json'), geometry);
      files.write(at('walk.png'), await walkPicture(painting, geometry, out.footprint));
      ran(at(), 'derive', carry?.old ?? painting);
      const open = geometry.walk.join('').split('#').length - 1;
      console.log(`${place.key}: ${open} walk cells, ${geometry.occluders.length} occluders, person ${Math.round(personPx(geometry, FRAME.height - 20))} px at the front (${geometry.scale.source})`);
    }));
    console.log(`spark calls sent: ${files.memo.sent.spark}`);
  },
});
