import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { serveWorld } from '../src/commands/play.ts';
import { WorldFiles } from '../src/world/files.ts';
import { playRoute } from '../src/qa/route.ts';
import { scene } from './fixtures/scene.ts';
import { npcWorld, npcStory } from './fixtures/npc-story.ts';

let root: string, browser: Browser, server: Awaited<ReturnType<typeof serveWorld>>, url: string;
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'npc-browser-'));
  const { put, geometry } = await scene(root, false, ['room', 'garden']);
  put('world.json', npcWorld); put('story.json', npcStory);
  const thing = (key: string, x: number, y: number, role: 'npc' | 'prop' | 'exit' = 'prop') => ({ key, role, box: [x - 30, y - 130, x + 30, y], stand: [x, y] });
  const room = { ...geometry, start: [700, 780], walk: geometry.walk.map((row, r) => r >= 30 && r < 90 ? row.slice(0, 74) + '..' + row.slice(76) : row), things: [
    thing('guard', 420, 650, 'npc'), thing('left-post', 300, 650), thing('right-post', 820, 650), thing('door', 1050, 740, 'exit'),
  ] };
  put('places/room/geometry.json', room);
  put('places/garden/geometry.json', { ...geometry, things: [thing('gate', 140, 700, 'exit'), thing('flowers', 820, 650)] });
  const svg = (colour: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="200"><circle cx="40" cy="28" r="24" fill="#e8bc8a"/><path d="M18 55H62L70 135H10Z" fill="${colour}"/><path d="M22 132V195M58 132V195" stroke="#4b3e32" stroke-width="15"/></svg>`);
  put('cast/guard.png', await sharp(svg('#478456')).png().toBuffer());
  put('cast/hero.png', await sharp(svg('#427ca9')).png().toBuffer());
  server = await serveWorld(new WorldFiles('w', root), 0);
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/?place=room&capture=1&sound=0`;
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (root) fs.rmSync(root, { recursive: true, force: true });
});
async function open() {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction('window.diorama?.place && window.diorama.dark === 0');
  return { page, errors };
}
const npc = `(Array.from(window.diorama.npcs.values()).find(n => n.key === 'guard'))`;
async function advance(page: Page, seconds: number) {
  return page.evaluate(`(() => { const g = window.diorama; for (let i=0;i<${Math.ceil(seconds * 60)};i++) g.update(1/60); g.render(); })()`);
}

test('NPC patrol navigates around walls, stays clickable, stops for conversation and resumes', async () => {
  const { page, errors } = await open();
  try {
    const samples = await page.evaluate(`(() => {
      const g=window.diorama, n=${npc}, samples=[];
      for(let i=0;i<1200;i++) { g.update(1/60); samples.push({x:n.body.x,y:n.body.y,phase:n.body.phase,walkable:g.place.grid.walkable(n.body.x,n.body.y)}); }
      g.render(); return samples;
    })()` ) as { x: number; y: number; phase: number; walkable: boolean }[];
    expect(samples.every(s => s.walkable)).toBe(true);
    expect(Math.min(...samples.map(s => s.x))).toBeLessThan(330);
    expect(Math.max(...samples.map(s => s.x))).toBeGreaterThan(790);
    expect(Math.max(...samples.map(s => s.y))).toBeGreaterThanOrEqual(720);
    expect(samples.at(-1)!.phase).toBeGreaterThan(1);
    await playRoute(page, [{ use: 'guard' }]);
    expect(await page.locator('#talk').isVisible()).toBe(true);
    const before = await page.evaluate(`${npc}.body.x`);
    await advance(page, 4);
    expect(await page.evaluate(`${npc}.body.x`)).toBe(before);
    await page.screenshot({ path: '/private/tmp/diorama-npc-conversation.png' });
    await page.keyboard.press('Escape');
    await page.waitForFunction('!window.diorama.state.talk && !window.diorama.speech');
    await advance(page, 6);
    expect(await page.evaluate(`${npc}.body.phase`)).toBeGreaterThan(samples.at(-1)!.phase);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 45_000);

test('story event walks out through an exit, moves the clickable NPC, and returns without duplication', async () => {
  const { page, errors } = await open();
  try {
    await playRoute(page, [{ use: 'guard' }, { act: { kind: 'choose', index: 0 } }]);
    expect(await page.evaluate('window.diorama.state.npcs')).toEqual({ guard: 'garden' });
    expect(await page.evaluate(`${npc}.place`)).toBe('room');
    const samples = await page.evaluate(`(() => {const g=window.diorama,n=${npc},xs=[];for(let i=0;i<1200 && n.place==='room';i++){g.update(1/60);xs.push(n.body.x);}g.render();return xs;})()`) as number[];
    expect(Math.max(...samples)).toBeGreaterThan(1045);
    expect(await page.evaluate(`${npc}.place`)).toBe('garden');
    expect(await page.evaluate('window.diorama.hots().some(h=>h.thing.key==="guard")')).toBe(false);
    await playRoute(page, [{ use: 'door' }]);
    expect(await page.evaluate('window.diorama.hots().filter(h=>h.thing.key==="guard").length')).toBe(1);
    await advance(page, 2);
    await page.screenshot({ path: '/private/tmp/diorama-npc-garden.png' });
    await playRoute(page, [{ use: 'guard' }, { act: { kind: 'choose', index: 0 } }, { use: 'gate' }]);
    expect(await page.evaluate('window.diorama.state.npcs')).toEqual({ guard: 'room' });
    expect(await page.evaluate('window.diorama.hots().filter(h=>h.thing.key==="guard").length')).toBe(1);
    expect(await page.evaluate('window.diorama.npcs.size')).toBe(1);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 60_000);

test('an event affecting an unseen NPC brings it to the destination entrance', async () => {
  const { page, errors } = await open();
  try {
    await page.evaluate(`(async()=>{ const g=window.diorama;g.state.place='garden';await g.enter('garden','room');
      g.state.npcs={guard:'room'};await g.syncNpcs();
      g.state.npcs={guard:'garden'};await g.syncNpcs(); })()`);
    expect(await page.evaluate(`${npc}.place`)).toBe('garden');
    expect(await page.evaluate(`${npc}.body.x`)).toBeLessThan(200);
    expect(await page.evaluate('window.diorama.hots().filter(h=>h.thing.key==="guard").length')).toBe(1);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30_000);

test('NPC walk sheets advance with gait and legacy talk-only sheets fall back while walking', async () => {
  const { page, errors } = await open();
  try {
    const colours = await page.evaluate(`(async()=> {
      const g=window.diorama,n=${npc},b=n.body;
      const img=new Image();img.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="200"><path fill="#00ff00" d="M0 0H80V200H0Z"/><path fill="#ff0000" d="M80 0H160V200H80Z"/></svg>');await img.decode();
      const sheet={file:'test',yaw:Math.PI/2,stand:0,img,gestures:['listen'],walk:[0,1]};
      const original=b.figure.sprites;
      b.figure.sprites={info:{cols:2,rows:1,frames:2,width:160,height:200,feetAt:1,px:200,facings:{}},sheets:[sheet],talk:[sheet]};
      b.x=400;b.y=650;b.foot=undefined;b.path=[[800,650]];b.yaw=Math.PI/2;
      g.hero.x=1100;g.hero.y=800;n.patrol=g.data.story.patrols[0];
      const pixel=()=> {g.render();return Array.from(document.querySelector('canvas').getContext('2d').getImageData(400,550,1,1).data);};
      b.phase=0.1;const first=pixel();b.phase=0.7;const second=pixel();
      b.figure.sprites.sheets=[];const fallback=pixel();b.figure.sprites=original;
      return {first,second,fallback};
    })()`) as { first: number[]; second: number[]; fallback: number[] };
    expect(colours.first[1]).toBeGreaterThan(colours.first[0] + 100);
    expect(colours.second[0]).toBeGreaterThan(colours.second[1] + 100);
    expect(colours.fallback[1]).toBeGreaterThan(colours.fallback[0]);
    expect(colours.fallback).not.toEqual(colours.first);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30_000);
