import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { Story } from '../../src/story/schema.ts';
import { verifyPlace } from '../../src/scene/verify.ts';
import type { World } from '../../src/world/schema.ts';

/** A complete local scene; the optional guard covers every clickable pixel of the token. */
export async function scene(root: string, guard = false, keys = ['room']) {
  const world: World = {
    title: 'Audit world', pitch: 'Find the red token in a quiet room.', style: 'simple coloured test shapes', start: keys[0],
    hero: { key: 'hero', looks: 'a person in a blue coat' },
    places: keys.map((key) => ({ key, shows: 'a quiet room with a red token', mood: 'calm', things: [
      { key: 'token', role: 'item', looks: 'a red token' }, ...(guard ? [{ key: 'guard', role: 'npc' as const, looks: 'a tall guard in a brown coat' }] : []),
    ], exits: [] })),
  };
  const geometry = {
    frame: { width: 1200, height: 896 }, cell: 8,
    walk: Array.from({ length: 112 }, (_, r) => (r >= 30 ? '#' : '.').repeat(150)),
    zone: Array.from({ length: 112 }, (_, r) => (r >= 30 ? '0' : '.').repeat(150)),
    scale: { horizonY: 100, pxPerY: 0.4, source: 'spark' as const }, start: [650, 700] as [number, number],
    things: [{ key: 'token', role: 'item' as const, kind: 'on-top' as const, box: [490, 540, 510, 560] as [number, number, number, number], stand: [500, 620] as [number, number], mask: 'masks/token.png' },
      ...(guard ? [{ key: 'guard', role: 'npc' as const, box: [460, 400, 540, 600] as [number, number, number, number], stand: [500, 600] as [number, number] }] : [])], occluders: [],
  };
  const notes = { things: { token: { phrase: 'a red token', kind: 'on-top', box: [490, 540, 510, 560], coarse: false, source: 'sam-text', check: { ok: true } } }, floors: { floor: { coarse: false, source: 'sam-text', iouLayout: 1 } }, flagged: [] };
  const put = (file: string, value: unknown) => { const at = path.join(root, 'w', file); fs.mkdirSync(path.dirname(at), { recursive: true }); fs.writeFileSync(at, Buffer.isBuffer(value) ? value : JSON.stringify(value)); };
  const svg = (mask: boolean) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="896"><rect width="1200" height="896" fill="${mask ? 'black' : '#e4dfc8'}"/><rect x="490" y="540" width="20" height="20" fill="${mask ? 'white' : 'red'}"/></svg>`);
  const painting = await sharp(svg(false)).png().toBuffer();
  const mask = await sharp(svg(true)).png().toBuffer();
  put('world.json', world);
  put('story.json', Story.parse({ intro: 'Find the token.', items: [{ key: 'token', name: 'Token' }], interactions: [{ place: keys[0], thing: 'token', verb: 'take', say: 'Found it.', once: true, do: [{ give: 'token' }, { ending: 'won' }] }], endings: [{ key: 'won', title: 'Won', text: 'You found the token.' }] }));
  for (const p of world.places) {
    put(`places/${p.key}/painting.png`, painting);
    put(`places/${p.key}/blockin.png`, painting);
    put(`places/${p.key}/masks/token.png`, mask);
    put(`places/${p.key}/masks.json`, notes);
    put(`places/${p.key}/geometry.json`, geometry);
    put(`places/${p.key}/verify.json`, verifyPlace(p, geometry, notes));
    put(`places/${p.key}/layout.json`, { horizon: 100, sky: '#ffffff', ground: '#aaaaaa', floors: [{ key: 'floor', is: 'floor', colour: '#aaaaaa', outline: [[0, 240], [1200, 240], [1200, 896], [0, 896]] }], things: [], lights: [] });
  }
  return { world, geometry, notes, put, dir: path.join(root, 'w') };
}
