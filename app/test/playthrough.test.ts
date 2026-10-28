import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { serveWorld } from '../src/commands/play.ts';
import { toStep } from '../src/commands/playthrough.ts';
import { playRoute } from '../src/qa/route.ts';
import { checkStory } from '../src/story/check.ts';
import { Story } from '../src/story/schema.ts';
import { WorldFiles } from '../src/world/files.ts';
import { scene } from './fixtures/scene.ts';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

test.each([false, true])('pointer playthrough detects a token covered by a guard: %s', async (covered) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-pointer-'));
  const { world } = await scene(root, covered);
  const files = new WorldFiles('w', root);
  const route = checkStory(world, files.readJson(files.path('story.json'))).routes[0];
  const server = await serveWorld(files, 0);
  const page = await browser.newPage({ viewport: { width: 1200, height: 960 } });
  try {
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/?capture=1&sound=0`);
    await page.waitForFunction('window.diorama?.place && !window.diorama.speech && window.diorama.dark === 0');
    if (covered) {
      await expect(playRoute(page, route.actions.map(toStep))).rejects.toThrow('No clickable pixel for token');
      expect(await page.evaluate('window.diorama.state.ending ?? null')).toBe(null);
    } else expect((await playRoute(page, route.actions.map(toStep))).ending).toBe('won');
  } finally { await page.close(); await new Promise<void>((r) => server.close(() => r())); fs.rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test('pointer routes select inventory items and the original index of a visible dialogue answer', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-pointer-talk-'));
  const { world, geometry, put } = await scene(root, true);
  geometry.things[1].box = [860, 400, 940, 600]; geometry.things[1].stand = [900, 620]; put('places/room/geometry.json', geometry);
  const story = Story.parse({ intro: 'Find the token.', items: [{ key: 'token', name: 'Token' }], interactions: [
    { place: 'room', thing: 'token', verb: 'take', once: true, say: 'A token.', do: [{ give: 'token' }] },
    { place: 'room', thing: 'guard', verb: 'use', with: 'token', once: true, say: 'Thank you.', do: [{ set: 'helped' }, { take: 'token' }] },
  ], dialogues: [{ place: 'room', npc: 'guard', when: ['helped'], start: 'hello', lines: [{ key: 'hello', says: 'Hello.', choices: [
    { text: 'Hidden answer', when: ['!helped'] }, { text: 'We did it.', when: ['helped'], do: [{ ending: 'won' }] },
  ] }] }], endings: [{ key: 'won', title: 'Won', text: 'You helped the guard.' }] });
  put('story.json', story);
  const report = checkStory(world, story); expect(report.issues).toEqual([]);
  const server = await serveWorld(new WorldFiles('w', root), 0);
  const page = await browser.newPage({ viewport: { width: 1200, height: 960 } });
  try {
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/?capture=1&sound=0`);
    await page.waitForFunction('window.diorama?.place && !window.diorama.speech && window.diorama.dark === 0');
    expect((await playRoute(page, report.routes[0].actions.map(toStep))).ending).toBe('won');
  } finally { await page.close(); await new Promise<void>((r) => server.close(() => r())); fs.rmSync(root, { recursive: true, force: true }); }
}, 60_000);

test('a target beside an overlay is clicked inside its exposed area, away from the moving edge', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-pointer-edge-'));
  const { world } = await scene(root);
  const files = new WorldFiles('w', root);
  const route = checkStory(world, files.readJson(files.path('story.json'))).routes[0];
  const server = await serveWorld(files, 0);
  const page = await browser.newPage({ viewport: { width: 1200, height: 960 } });
  try {
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/?capture=1&sound=0`);
    await page.waitForFunction('window.diorama?.place && !window.diorama.speech && window.diorama.dark === 0');
    const box = await page.evaluate(`(() => {
      const box = window.diorama.pageRect('token');
      const cover = document.createElement('div');
      Object.assign(cover.style, { position: 'fixed', zIndex: '100', left: (box.left + box.width / 2) + 'px', top: box.top + 'px', width: box.width + 'px', height: box.height + 'px' });
      document.body.appendChild(cover);
      document.querySelector('canvas').addEventListener('click', e => window.testClick = { x: e.clientX, y: e.clientY }, { once: true });
      return box.toJSON();
    })()`) as { left: number; top: number; width: number; bottom: number };
    expect((await playRoute(page, route.actions.map(toStep))).ending).toBe('won');
    const click = await page.evaluate('window.testClick') as { x: number; y: number };
    expect(click.x).toBeGreaterThan(box.left + 2);
    expect(click.x).toBeLessThan(box.left + box.width / 2 - 1);
    expect(click.y).toBeGreaterThan(box.top + 2);
    expect(click.y).toBeLessThan(box.bottom - 2);
  } finally { await page.close(); await new Promise<void>((r) => server.close(() => r())); fs.rmSync(root, { recursive: true, force: true }); }
}, 30_000);
