// The build-up reel: one still per step of a place's build, from the files the steps left behind.
// The demo film plays these on a beat, so each still says which step it is and which model made it.
import fs from 'node:fs';
import sharp from 'sharp';
import { FRAME } from '../scene/layout.ts';
import type { Critique } from '../scene/critic.ts';
import type { World } from '../world/schema.ts';
import type { WorldFiles } from '../world/files.ts';

export const SCREEN = { width: 1920, height: 1080 } as const;
// The painting sits centred, scaled to leave room for the caption under it.
const SCALE = 1000 / FRAME.height;
const BOX = { width: Math.round(FRAME.width * SCALE), height: 1000 };
const LEFT = Math.round((SCREEN.width - BOX.width) / 2);
const TOP = 16;

export type Beat = {
  key: string;
  title: string;
  /** Who made what this beat shows: a Meta model, or code. */
  by: string;
  still: Buffer;
  /** How this beat comes in over the one before (an ffmpeg xfade transition). */
  enter: 'fade' | 'wipeleft' | 'circleopen';
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The caption under the picture: step title and a badge naming the model. */
function captionSvg(title: string, by: string): string {
  const badge = Math.round(by.length * 14 + 44);
  return `<rect x="${LEFT}" y="${SCREEN.height - 62}" width="${badge}" height="44" rx="22" fill="#2f5bea"/>
<text x="${LEFT + 18}" y="${SCREEN.height - 32}" font-family="DejaVu Sans, sans-serif" font-size="22" font-weight="bold" fill="#fff">${esc(by)}</text>
<text x="${LEFT + badge + 20}" y="${SCREEN.height - 31}" font-family="DejaVu Sans, sans-serif" font-size="26" fill="#e8e6ee">${esc(title)}</text>`;
}

/** A painting-sized picture placed on the black screen, with optional drawing over it (in painting pixels). */
async function onScreen(picture: Buffer | null, over: string, title: string, by: string, clean: boolean): Promise<Buffer> {
  const layers: sharp.OverlayOptions[] = [];
  if (picture) {
    const fitted = await sharp(picture).resize(BOX.width, BOX.height, { fit: 'fill' }).png().toBuffer();
    layers.push({ input: fitted, left: LEFT, top: TOP });
  }
  const scaled = over && `<g transform="translate(${LEFT} ${TOP}) scale(${SCALE})">${over}</g>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SCREEN.width}" height="${SCREEN.height}">${scaled}${clean ? '' : captionSvg(title, by)}</svg>`;
  layers.push({ input: Buffer.from(svg), left: 0, top: 0 });
  return sharp({ create: { width: SCREEN.width, height: SCREEN.height, channels: 3, background: '#000' } })
    .composite(layers).png().toBuffer();
}

/** The world as Spark wrote it: places as cards, exits as lines, in painting pixels. */
export function worldSvg(world: World, focus: string): string {
  const n = world.places.length;
  const w = 340, h = 140;
  // Up to three places stand in a row; more go round an ellipse.
  const pos = new Map(world.places.map((p, i) => {
    if (n <= 3) return [p.key, { x: FRAME.width / 2 + (i - (n - 1) / 2) * (w + 80) - w / 2, y: 470 - h / 2 }];
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    return [p.key, { x: FRAME.width / 2 + Math.cos(a) * 360 - w / 2, y: 500 + Math.sin(a) * 230 - h / 2 }];
  }));
  const lines = world.places.flatMap((p) => p.exits.map((e) => {
    const a = pos.get(p.key)!, b = pos.get(e.to);
    return b ? `<line x1="${a.x + w / 2}" y1="${a.y + h / 2}" x2="${b.x + w / 2}" y2="${b.y + h / 2}" stroke="#7d86a8" stroke-width="4" stroke-dasharray="10 8"/>` : '';
  }));
  const cards = world.places.map((p) => {
    const { x, y } = pos.get(p.key)!;
    const hot = p.key === focus;
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${hot ? '#2f5bea' : '#1b1d26'}" stroke="${hot ? '#9fb4ff' : '#3a3f55'}" stroke-width="3"/>
<text x="${x + 22}" y="${y + 56}" font-family="DejaVu Sans, sans-serif" font-size="34" font-weight="bold" fill="#fff">${esc(p.key)}</text>
<text x="${x + 22}" y="${y + 104}" font-family="DejaVu Sans, sans-serif" font-size="24" fill="#c9cde0">${p.things.length} things · ${p.exits.length} exit${p.exits.length === 1 ? '' : 's'}</text>`;
  });
  const pitch = world.pitch.length > 110 ? `${world.pitch.slice(0, 107)}…` : world.pitch;
  return `<text x="60" y="90" font-family="DejaVu Serif, serif" font-size="52" font-weight="bold" fill="#fff">${esc(world.title)}</text>
<text x="60" y="140" font-family="DejaVu Sans, sans-serif" font-size="22" fill="#a9adc0">${esc(pitch)}</text>
${lines.join('')}${cards.join('')}`;
}

/** Numbered frames round the regions the critic asked to repaint, and the list of fixes in a panel. */
export function critiqueSvg(found: Critique, colour = '#ff4a3d', list = true): string {
  const frames = found.issues.map((i, n) => {
    const [x0, y0, x1, y1] = i.region;
    return `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="none" stroke="${colour}" stroke-width="5" rx="6"/>
<circle cx="${x0}" cy="${y0}" r="20" fill="${colour}"/>
<text x="${x0}" y="${y0 + 8}" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-size="22" font-weight="bold" fill="#fff">${n + 1}</text>`;
  });
  if (!list) return frames.join('');
  const rows = found.issues.map((i, n) => {
    const fix = i.fix.length > 78 ? `${i.fix.slice(0, 75)}…` : i.fix;
    return `<text x="40" y="${FRAME.height - 40 - (found.issues.length - 1 - n) * 34}" font-family="DejaVu Sans, sans-serif" font-size="22" fill="#fff">${n + 1}. ${esc(i.problem)}: ${esc(fix)}</text>`;
  });
  const top = FRAME.height - 70 - found.issues.length * 34;
  return `${frames.join('')}<rect x="20" y="${top}" width="${FRAME.width - 40}" height="${FRAME.height - 20 - top}" rx="12" fill="#000" fill-opacity="0.66"/>${rows.join('')}`;
}

/** Every beat the files of one place allow, in build order; steps not run yet are left out. */
export async function placeBeats(files: WorldFiles, placeKey: string, clean = false): Promise<Beat[]> {
  const world = files.world();
  const place = world.places.find((p) => p.key === placeKey);
  if (!place) throw new Error(`no place "${placeKey}" in ${files.slug}; places: ${world.places.map((p) => p.key).join(', ')}`);
  const at = (...parts: string[]) => files.place(place.key, ...parts);
  const has = (...parts: string[]) => fs.existsSync(at(...parts));
  const read = (...parts: string[]) => fs.readFileSync(at(...parts));
  const beats: Beat[] = [];
  const add = async (key: string, title: string, by: string, picture: Buffer | null, over = '', enter: Beat['enter'] = 'fade') =>
    beats.push({ key, title, by, enter, still: await onScreen(picture, over, title, by, clean) });

  await add('world', `One sentence becomes a world: ${world.places.length} places, a hero, a story`, 'Muse Spark', null, worldSvg(world, place.key));
  if (has('photo.png')) await add('photo', 'A real photo is the first place', 'Camera', read('photo.png'));
  if (has('blockin.png')) await add('layout', 'Spark lays out every thing, light and floor', 'Muse Spark', read('blockin.png'));
  if (has('painting-first.png')) await add('paint', 'Muse paints over the block-in', 'Muse Image', read('painting-first.png'), '', 'wipeleft');
  const critique = has('critique.json') ? (JSON.parse(read('critique.json').toString()) as Critique) : null;
  if (critique?.issues.length && has('painting-first.png')) {
    await add('critic', `Spark finds ${critique.issues.length} thing${critique.issues.length === 1 ? '' : 's'} to fix`, 'Muse Spark', read('painting-first.png'), critiqueSvg(critique));
    if (has('painting.png')) await add('repaint', 'Muse repaints only those regions', 'Muse Image', read('painting.png'), critiqueSvg(critique, '#3ddc84', false));
  } else if (has('painting.png') && !has('painting-first.png')) await add('paint', 'Muse paints over the block-in', 'Muse Image', read('painting.png'), '', 'wipeleft');
  if (has('masks', 'overlay.png')) await add('masks', 'SAM 3.1 cuts out every thing and the floor', 'SAM 3.1', read('masks', 'overlay.png'), '', 'circleopen');
  if (has('walk.png')) await add('walk', 'Floor, scale and occlusion measured from the masks', 'SAM 3.1 + code', read('walk.png'));
  if (has('verify.json') && has('painting.png')) {
    const v = JSON.parse(read('verify.json').toString()) as { ok: boolean; errors: unknown[]; flags: unknown[] };
    const mark = v.ok ? '#3ddc84' : '#ff4a3d';
    const over = `<rect x="0" y="0" width="${FRAME.width}" height="${FRAME.height}" fill="none" stroke="${mark}" stroke-width="12"/>
<text x="${FRAME.width - 40}" y="80" text-anchor="end" font-family="DejaVu Sans, sans-serif" font-size="54" font-weight="bold" fill="${mark}" stroke="#000" stroke-width="5" paint-order="stroke">${v.ok ? 'PLAYABLE' : `${v.errors.length} ERRORS`}</text>`;
    await add('verify', v.ok ? 'Every check passes: the scene is playable' : 'Verify found problems to fix', 'code', read('painting.png'), over);
  }
  return beats;
}
