// blockin.png: the layout as a shaded sketch. Muse keeps where things are and paints what they are.
// Flat soft boxes told Muse only "something goes here", so it moved and resized them freely: a stage floor
// with a vanishing grid, a silhouette per kind of thing with its top lit and its shadow on the floor say
// how deep each thing stands and what it roughly is (ootb measure 10-28: median IoU of painted things
// against the plan was 0.25 with boxes).
import sharp from 'sharp';
import type { Place } from '../world/schema.ts';

type Thing = Place['things'][number];
import { FRAME, type Layout, type Shape } from './layout.ts';

type Box = Layout['things'][number];

const WORDS: [Shape, RegExp][] = [
  ['steps', /\b(steps?|stairs?|staircase|stairway|ladder)(e?s)?\b/],
  ['flat', /\b(rug|carpet|water|pond|puddle|pool|tracks?|rails?|path|road|mat|stream|canal|river)(e?s)?\b/],
  ['arch', /\b(door|doorway|gate|arch|archway|tunnel|portal|entrance|passage|window)(e?s)?\b/],
  ['tree', /\b(tree|willow|oak|pine|birch|palm|grove|orchard)(e?s)?\b/],
  ['post', /\b(lamp|lantern post|street ?light|post|pole|sign ?post|mast|torch|column|pillar|chimney)(e?s)?\b/],
  ['round', /\b(barrel|pot|jar|urn|bucket|basket|rock|boulder|bush|shrub|reeds?|well|cauldron|sack|haystack|pumpkin|crock)(e?s)?\b/],
  ['low', /\b(bench|boat|cart|bed|sofa|couch|table|desk|trough|log|bridge|crate|chest|box)(e?s)?\b/],
];

/**
 * Layouts laid out before Spark named shapes (or a shape it left out) get one from the thing's words:
 * its key first ("curving-tram-tracks" lie flat though their looks run "into a dark arch"), then its looks.
 */
export function shapeOf(box: Box, thing?: Thing): Shape {
  if (box.shape) return box.shape;
  for (const words of [box.key.replace(/-/g, ' '), (thing?.looks ?? '').toLowerCase()])
    for (const [shape, re] of WORDS) if (re.test(words)) return shape;
  return box.height > 2.5 * box.width ? 'post' : box.width > 2 * box.height ? 'low' : 'block';
}

const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
/** k > 0 towards white, k < 0 towards black. */
export function shade(colour: string, k: number): string {
  const to = k > 0 ? 255 : 0;
  return `#${hex(colour).map((v) => Math.round(v + (to - v) * Math.abs(k)).toString(16).padStart(2, '0')).join('')}`;
}

/** How much of a thing's top the stage camera sees: none at the horizon, more the nearer it stands. */
const topOf = (layout: Layout, b: Box) => Math.max(4, Math.min(0.35 * b.height, 0.22 * b.width * ((b.footY - layout.horizon) / (FRAME.height - layout.horizon))));

/** One thing as a silhouette standing on the floor: body, lit top, a dark rim, its shadow first. */
function thingSvg(layout: Layout, b: Box, shape: Shape, i: number): string {
  const { x, footY: y, width: w, height: h, colour: c } = b;
  const l = x - w / 2, r = x + w / 2, t = y - h;
  const rim = `stroke="${shade(c, -0.55)}" stroke-width="3" stroke-linejoin="round"`;
  const body = `fill="url(#b${i})" ${rim}`;
  const lit = `fill="${shade(c, 0.32)}" ${rim}`;
  const dark = shade(c, -0.6);
  const grad = `<linearGradient id="b${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${shade(c, 0.12)}"/><stop offset="1" stop-color="${shade(c, -0.28)}"/></linearGradient>`;
  const shadow = shape === 'flat' ? '' : `<ellipse cx="${x + w * 0.06}" cy="${y}" rx="${w * 0.62}" ry="${Math.max(6, w * 0.11)}" fill="#000" fill-opacity="0.38" filter="url(#soft)"/>`;
  const top = topOf(layout, b);
  const parts: string[] = [];
  switch (shape) {
    case 'flat': {
      // Lies on the floor: a squashed oval, seen from above.
      const d = Math.max(10, Math.min(h, w * 0.35));
      parts.push(`<ellipse cx="${x}" cy="${y - d / 2}" rx="${w / 2}" ry="${d / 2}" fill="${c}" ${rim}/>`, `<ellipse cx="${x - w * 0.08}" cy="${y - d * 0.62}" rx="${w * 0.3}" ry="${d * 0.18}" fill="${shade(c, 0.25)}"/>`);
      break;
    }
    case 'post': {
      const pole = Math.max(8, w * 0.22), head = Math.min(w, h * 0.3);
      parts.push(`<rect x="${x - pole / 2}" y="${t + head * 0.7}" width="${pole}" height="${h - head * 0.7}" ${body}/>`,
        `<rect x="${x - pole}" y="${y - pole * 0.8}" width="${pole * 2}" height="${pole * 0.8}" ${body}/>`,
        `<rect x="${x - head / 2}" y="${t}" width="${head}" height="${head * 0.9}" rx="${head * 0.2}" ${lit}/>`);
      break;
    }
    case 'tree': {
      const trunk = Math.max(10, w * 0.16);
      parts.push(`<rect x="${x - trunk / 2}" y="${t + h * 0.45}" width="${trunk}" height="${h * 0.55}" fill="${dark}" ${rim}/>`,
        `<ellipse cx="${x}" cy="${t + h * 0.33}" rx="${w / 2}" ry="${h * 0.33}" ${body}/>`,
        `<ellipse cx="${x - w * 0.12}" cy="${t + h * 0.22}" rx="${w * 0.26}" ry="${h * 0.14}" fill="${shade(c, 0.25)}"/>`);
      break;
    }
    case 'arch': {
      // A frame with a dark opening: a door, gate or passage leads somewhere.
      const ro = w / 2, fw = Math.max(8, w * 0.16);
      const ri = ro - fw;
      parts.push(`<path d="M${l},${y} L${l},${t + ro} A${ro},${ro} 0 0 1 ${r},${t + ro} L${r},${y} Z" ${body}/>`,
        `<path d="M${l + fw},${y} L${l + fw},${t + ro + fw * 0.4} A${ri},${ri} 0 0 1 ${r - fw},${t + ro + fw * 0.4} L${r - fw},${y} Z" fill="${dark}"/>`);
      break;
    }
    case 'round': {
      const e = Math.max(6, Math.min(top, w * 0.18));
      parts.push(`<path d="M${l},${t + e} L${l},${y - e} A${w / 2},${e} 0 0 0 ${r},${y - e} L${r},${t + e} Z" ${body}/>`,
        `<ellipse cx="${x}" cy="${t + e}" rx="${w / 2}" ry="${e}" ${lit}/>`);
      break;
    }
    case 'steps': {
      const n = 4, rise = h / n;
      for (let s = 0; s < n; s++) {
        const inset = (w * 0.12 * s) / n;
        const sy = y - (s + 1) * rise;
        parts.push(`<rect x="${l + inset}" y="${sy}" width="${w - 2 * inset}" height="${rise}" fill="${shade(c, -0.25 + 0.12 * s)}" ${rim}/>`,
          `<rect x="${l + inset + 3}" y="${sy + 2}" width="${w - 2 * inset - 6}" height="${Math.max(3, rise * 0.25)}" fill="${shade(c, 0.3)}"/>`);
      }
      break;
    }
    default: {
      // block and low: a box with its top seen from a little above.
      const slant = top * 0.5;
      parts.push(`<rect x="${l}" y="${t + top}" width="${w}" height="${h - top}" ${body}/>`,
        `<path d="M${l},${t + top} L${l + slant},${t} L${r - slant},${t} L${r},${t + top} Z" ${lit}/>`);
    }
  }
  return `<defs>${grad}</defs>${shadow}${parts.join('')}`;
}

/** A floor tiled towards the vanishing point, so it reads as ground going back, not a coloured band. */
function floorSvg(layout: Layout, f: Layout['floors'][number], i: number): string {
  const { width: W, height: H } = FRAME;
  const vx = W / 2, vy = layout.horizon;
  const pts = f.outline.map((p) => p.join(',')).join(' ');
  const lines: string[] = [];
  for (let k = -8; k <= 8; k++) lines.push(`M${vx},${vy} L${vx + k * W * 0.32},${H + 400}`);
  // Rows close up towards the horizon as perspective does.
  for (let d = 1; d <= 14; d++) {
    const y = vy + (H - vy) * (1 / (1 + 0.45 * (14 - d))) ;
    lines.push(`M0,${y} L${W},${y}`);
  }
  return `<clipPath id="f${i}"><polygon points="${pts}"/></clipPath>
<polygon points="${pts}" fill="${f.colour}"/>
<path d="${lines.join(' ')}" stroke="${shade(f.colour, -0.35)}" stroke-width="2" stroke-opacity="0.35" fill="none" clip-path="url(#f${i})"/>
<polygon points="${pts}" fill="none" stroke="${shade(f.colour, 0.3)}" stroke-width="3" stroke-opacity="0.8"/>`;
}

/** NPCs get a spot in the layout but no mass: a character painted into the background can't move. */
export function blockinSvg(layout: Layout, place: Place): string {
  const { width: W, height: H } = FRAME;
  const npcs = new Set(place.things.filter((t) => t.role === 'npc').map((t) => t.key));
  const things = layout.things
    .filter((t) => !npcs.has(t.key))
    .sort((a, b) => a.footY - b.footY) // far first, near on top
    .map((t, i) => thingSvg(layout, t, shapeOf(t, place.things.find((p) => p.key === t.key)), i));
  const glows = layout.lights.map((l, i) => `<radialGradient id="g${i}"><stop offset="0" stop-color="${l.colour}" stop-opacity="0.9"/><stop offset="0.25" stop-color="${l.colour}" stop-opacity="0.5"/><stop offset="1" stop-color="${l.colour}" stop-opacity="0"/></radialGradient><circle cx="${l.x}" cy="${l.y}" r="80" fill="url(#g${i})"/><circle cx="${l.x}" cy="${l.y}" r="9" fill="#fffbe8"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<defs><filter id="soft"><feGaussianBlur stdDeviation="6"/></filter>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${shade(layout.sky, -0.25)}"/><stop offset="1" stop-color="${shade(layout.sky, 0.18)}"/></linearGradient>
<linearGradient id="ground" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${shade(layout.ground, 0.12)}"/><stop offset="1" stop-color="${shade(layout.ground, -0.3)}"/></linearGradient></defs>
<rect width="${W}" height="${layout.horizon}" fill="url(#sky)"/>
<rect y="${layout.horizon}" width="${W}" height="${H - layout.horizon}" fill="url(#ground)"/>
<path d="M0,${layout.horizon} L${W},${layout.horizon}" stroke="${shade(layout.ground, -0.45)}" stroke-width="3"/>
${[...layout.floors.map((f, i) => floorSvg(layout, f, i)), ...things, ...glows].join('\n')}
</svg>`;
}

/** Barely softened: the silhouettes are meant to be followed, only their hard pixel edges are not. */
export function renderBlockin(layout: Layout, place: Place): Promise<Buffer> {
  return sharp(Buffer.from(blockinSvg(layout, place))).blur(1.5).png().toBuffer();
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * plan.png, for people: the block-in with every thing and floor named, as a plan sheet reads. Muse never sees
 * it (it would paint the words); Studio and the film show it, so the shapes read as a deliberate plan.
 */
export function planSvg(layout: Layout, place: Place, names: Record<string, string> = {}): string {
  const { width: W, height: H } = FRAME;
  const name = (key: string) => esc(names[key] ?? key.replace(/-/g, ' '));
  const tag = (x: number, y: number, text: string, big: boolean) => {
    const size = big ? 26 : 21, w = text.length * size * 0.56 + 24;
    const cx = Math.min(W - w / 2 - 6, Math.max(w / 2 + 6, x));
    return `<g font-family="Inter, Helvetica, Arial, sans-serif" font-size="${size}" font-weight="${big ? 600 : 500}">
<rect x="${cx - w / 2}" y="${y - size - 4}" width="${w}" height="${size + 14}" rx="${(size + 14) / 2}" fill="${big ? '#fffaf0' : '#1d1b22'}" fill-opacity="${big ? 0.94 : 0.72}"/>
<text x="${cx}" y="${y + 1}" text-anchor="middle" fill="${big ? '#2a2420' : '#f4efe6'}"${big ? '' : ' font-style="italic"'}>${text}</text></g>`;
  };
  const npcs = new Set(place.things.filter((t) => t.role === 'npc').map((t) => t.key));
  const things = layout.things.map((t) => {
    if (npcs.has(t.key)) {
      // A person is painted later, on their own: a dashed spot where they will stand.
      return `<ellipse cx="${t.x}" cy="${t.footY}" rx="${t.width / 2}" ry="${Math.max(8, t.width * 0.14)}" fill="none" stroke="#fffaf0" stroke-width="3" stroke-dasharray="8 7"/>${tag(t.x, t.footY - 14, name(t.key), true)}`;
    }
    const top = shapeOf(t, place.things.find((p) => p.key === t.key)) === 'flat' ? t.footY - Math.max(10, Math.min(t.height, t.width * 0.35)) : t.footY - t.height;
    return `<line x1="${t.x}" y1="${top - 6}" x2="${t.x}" y2="${top + 10}" stroke="#fffaf0" stroke-width="2"/>${tag(t.x, Math.max(30, top - 12), name(t.key), true)}`;
  });
  const floors = layout.floors.map((f) => {
    const xs = f.outline.map(([x]) => x), ys = f.outline.map(([, y]) => y);
    return tag((Math.min(...xs) + Math.max(...xs)) / 2, Math.max(...ys) - 18, name(f.key), false);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${[...floors, ...things].join('\n')}</svg>`;
}

export function renderPlan(layout: Layout, place: Place, blockin: Buffer, names?: Record<string, string>): Promise<Buffer> {
  return sharp(blockin).resize(FRAME.width, FRAME.height, { fit: 'fill' }).composite([{ input: Buffer.from(planSvg(layout, place, names)) }]).png().toBuffer();
}
