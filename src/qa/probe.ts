// The in-page half of the explorer. It runs inside the play page (as a string, so no bundler
// helpers leak in) and uses the page's own renderer: whatever the game draws is what gets checked.
//
// For each position it renders three frames over the hero's box: the place without him (once),
// with him and occlusion, and with him but nothing put back. Drawn = differs from the empty
// place without occlusion; hidden = drawn but the occluded frame shows the empty place there.

export type ProbeHit = {
  x: number;
  y: number;
  /** Hero pixels without occlusion, and how many of them occlusion put the painting back over. */
  drawn: number;
  hidden: number;
  /** Visible hero pixels over a thing whose floor line is nearer than his feet: he should be behind it. */
  overNearer: Record<string, number>;
  /** Hidden hero pixels under a thing whose floor line is behind his feet: he should be in front of it. */
  hiddenByFarther: Record<string, number>;
  /** Things whose floor footprint holds his feet: he would stand inside them. */
  feetIn: string[];
  /** Share of his height above the top of the frame or of his width outside its sides. */
  off: number;
};

export const PROBE_JS = String.raw`async ({ placeKey, positions }) => {
  const game = window.diorama;
  if (!game.place || game.place.key !== placeKey) await game.enter(placeKey);
  const place = game.place;
  const g = place.g;
  const W = g.frame.width, H = g.frame.height;
  const canvas = document.getElementById('view');
  const ctx = canvas.getContext('2d');
  game.hero.path = []; game.speech = null; game.hover = undefined; game.grid = false; game.dark = 0;
  if (typeof game.darkTarget === 'number') game.darkTarget = 0;

  const lineAt = (line, x) => {
    if (x <= line[0][0]) return line[0][1];
    for (let i = 1; i < line.length; i++) {
      if (x <= line[i][0]) {
        const [x0, y0] = line[i - 1], [x1, y1] = line[i];
        return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
      }
    }
    return line[line.length - 1][1];
  };
  const occ = new Map(g.occluders.map((o) => [o.key, o]));
  // Where each thing meets the floor at column x. Walls and water have no such line, and a coarse
  // mask is a box around the thing, not its outline, so overlaps with it say nothing.
  const things = place.hots.filter((h) => h.mask && !h.thing.coarse && h.thing.kind !== 'walk-on' && h.thing.kind !== 'wall' && h.thing.kind !== 'flat').map((h) => {
    const own = g.occluders.filter((o) => (o.thing ?? o.key) === h.thing.key);
    const base = (x) => {
      const o = own.find((o) => x >= o.box[0] && x < o.box[2]) ?? own[0];
      if (!o) return h.thing.box[3];
      const under = o.on ? occ.get(o.on) : undefined;
      const ref = under ?? o;
      return ref.floor && ref.floor.length ? lineAt(ref.floor, x) : ref.baseY;
    };
    return { key: h.thing.key, bits: h.mask.bits, box: h.thing.box, base, solid: h.thing.kind === 'standing' };
  });

  const person = (y) => Math.max(8, g.scale.pxPerY * (y - g.scale.horizonY));
  const region = (x0, y0, x1, y1) => ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  game.hero.x = -5000; game.hero.y = H - 1;
  game.render();
  const empty = ctx.getImageData(0, 0, W, H).data;
  const cuts = place.cuts;
  const out = [];
  for (const [x, y] of positions) {
    const h = person(y);
    const w = game.hero.img ? (h * game.hero.img.width) / game.hero.img.height : h * 0.36;
    const off = Math.max(0, h - y) / h + (Math.max(0, w / 2 - x) + Math.max(0, x + w / 2 - W)) / w;
    const x0 = Math.max(0, Math.floor(x - w / 2 - 3)), x1 = Math.min(W, Math.ceil(x + w / 2 + 3));
    const y0 = Math.max(0, Math.floor(y - h - 3)), y1 = Math.min(H, Math.ceil(y + 4));
    Object.assign(game.hero, { x, y, facing: 1, phase: 0 });
    place.cuts = cuts; game.render();
    const occluded = region(x0, y0, x1, y1);
    place.cuts = []; game.render();
    const bare = region(x0, y0, x1, y1);
    place.cuts = cuts;
    const hit = { x, y, drawn: 0, hidden: 0, overNearer: {}, hiddenByFarther: {}, feetIn: [], off: Math.round(off * 100) / 100 };
    const rw = x1 - x0;
    for (let py = y0; py < y1; py++) {
      // The shadow under his feet is not him.
      if (py > y - Math.max(3, h * 0.04)) continue;
      for (let px = x0; px < x1; px++) {
        const r = ((py - y0) * rw + (px - x0)) * 4, f = (py * W + px) * 4;
        const diff = Math.abs(bare[r] - empty[f]) + Math.abs(bare[r + 1] - empty[f + 1]) + Math.abs(bare[r + 2] - empty[f + 2]);
        if (diff < 30) continue;
        hit.drawn++;
        const back = Math.abs(occluded[r] - empty[f]) + Math.abs(occluded[r + 1] - empty[f + 1]) + Math.abs(occluded[r + 2] - empty[f + 2]) < 12;
        if (back) hit.hidden++;
        for (const t of things) {
          if (px < t.box[0] || px >= t.box[2] || py < t.box[1] || py >= t.box[3] || !t.bits[py * W + px]) continue;
          const base = t.base(px);
          if (!back && base > y + 8) hit.overNearer[t.key] = (hit.overNearer[t.key] ?? 0) + 1;
          if (back && base < y - 8) hit.hiddenByFarther[t.key] = (hit.hiddenByFarther[t.key] ?? 0) + 1;
        }
      }
    }
    // Inside a footprint: between where a thing meets the floor and a third of its width behind that.
    for (const o of g.occluders) {
      const cell = (o.foot ?? []).find(([fx]) => Math.abs(fx - x) <= 3);
      if (cell && y > cell[1] + 2 && y < cell[2] - 2 && !hit.feetIn.includes(o.thing ?? o.key)) hit.feetIn.push(o.thing ?? o.key);
    }
    out.push(hit);
  }
  game.render();
  return out;
}`;

/** Renders the hero at one spot and returns a PNG crop around him, for the juror's contact sheet. */
export const CROP_JS = String.raw`async ({ placeKey, x, y, size }) => {
  const game = window.diorama;
  if (!game.place || game.place.key !== placeKey) await game.enter(placeKey);
  const g = game.place.g;
  Object.assign(game.hero, { x, y, facing: 1, phase: 0, path: [] });
  game.speech = null; game.hover = undefined; game.grid = false;
  game.render();
  const h = Math.max(8, g.scale.pxPerY * (y - g.scale.horizonY));
  const side = Math.max(size, Math.ceil(h * 1.5));
  const cx = Math.round(Math.min(g.frame.width - side / 2, Math.max(side / 2, x)));
  const cy = Math.round(Math.min(g.frame.height - side / 2, Math.max(side / 2, y - h / 2)));
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  c.getContext('2d').drawImage(document.getElementById('view'), cx - side / 2, cy - side / 2, side, side, 0, 0, size, size);
  return c.toDataURL('image/png');
}`;
