// blockin.png: the layout as soft colour masses. Muse keeps where they are and paints what they are.
import sharp from 'sharp';
import type { Place } from '../world/schema.ts';
import { FRAME, type Layout } from './layout.ts';

/** NPCs get a spot in the layout but no mass: a character painted into the background can't move. */
export function blockinSvg(layout: Layout, place: Place): string {
  const { width: W, height: H } = FRAME;
  const npcs = new Set(place.things.filter((t) => t.role === 'npc').map((t) => t.key));
  const floors = layout.floors.map((f) => `<polygon fill="${f.colour}" points="${f.outline.map((p) => p.join(',')).join(' ')}"/>`);
  const things = layout.things
    .filter((t) => !npcs.has(t.key))
    .sort((a, b) => a.footY - b.footY) // far first, near on top
    .map((t) => `<rect fill="${t.colour}" x="${t.x - t.width / 2}" y="${t.footY - t.height}" width="${t.width}" height="${t.height}" rx="${Math.min(t.width, t.height) / 5}"/>`);
  const glows = layout.lights.map((l, i) => `<radialGradient id="g${i}"><stop offset="0" stop-color="${l.colour}" stop-opacity="0.85"/><stop offset="1" stop-color="${l.colour}" stop-opacity="0"/></radialGradient><circle cx="${l.x}" cy="${l.y}" r="56" fill="url(#g${i})"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<rect width="${W}" height="${layout.horizon}" fill="${layout.sky}"/>
<rect y="${layout.horizon}" width="${W}" height="${H - layout.horizon}" fill="${layout.ground}"/>
${[...floors, ...things, ...glows].join('\n')}
</svg>`;
}

/** Blurred so Muse reads composition rather than hard shapes to trace. */
export function renderBlockin(layout: Layout, place: Place): Promise<Buffer> {
  return sharp(Buffer.from(blockinSvg(layout, place))).blur(6).png().toBuffer();
}
