// Studio never scrolls as a page (Grzegorz: "nie chcę foldów w tej appce"): every screen and state, at three window
// sizes and with the agent docked each way, fits the window; long content scrolls inside its own panel.
import sharp from 'sharp';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startStudio, type Studio } from '../src/studio/server.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-diorama.mjs', import.meta.url));
const SIZES = [[1000, 700], [1440, 860], [1920, 1080]] as const;
const DOCKS = ['right', 'left', 'float', 'folded'] as const;
const LONG = 'a wide sunny farm yard seen slightly from above, open dirt ground in front for walking, low wooden fences along both sides, a large red barn with a wide wooden door at the back, a wooden cart with golden hay and a blue water pump nearby, green meadow and blue sky beyond';

type Browser = import('playwright').Browser;
let browser: Browser | null = null;
let studio: Studio;
let root: string;

const png = (r: number, g: number, b: number) => sharp({ create: { width: 1200, height: 896, channels: 3, background: { r, g, b } } }).png().toBuffer();

beforeAll(async () => {
  try {
    browser = await (await import('playwright')).chromium.launch();
  } catch {
    browser = null; // No browser here (npm run browsers): the test says so and passes.
    return;
  }
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-fold-'));
  const keys = ['farm-yard', 'barn-interior', 'orchard-hill', 'duck-pond', 'market-square', 'old-mill'];
  fs.mkdirSync(path.join(root, 'farm', 'memo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'farm', 'memo', 'calls.jsonl'), '');
  fs.writeFileSync(path.join(root, 'farm', 'world.json'), JSON.stringify({
    title: 'Sunny Farmyard Friends', pitch: `${LONG}. ${LONG}.`, style: 'gouache, warm farm colours', start: keys[0],
    hero: { key: 'young-caretaker', looks: 'a child in green overalls' },
    places: keys.map((key) => ({ key, shows: LONG, mood: 'calm', things: [{ key: 'red-barn-door-that-opens', role: 'exit', looks: 'a red door' }], exits: [] })),
  }));
  for (const [i, key] of keys.entries()) {
    const at = path.join(root, 'farm', 'places', key);
    fs.mkdirSync(path.join(at, 'masks'), { recursive: true });
    if (i === keys.length - 1) continue; // one place not painted yet
    fs.writeFileSync(path.join(at, 'layout.json'), '{}');
    for (const [file, c] of [['blockin.png', 60], ['painting.png', 120], ['masks/overlay.png', 160], ['walk.png', 200]] as const) fs.writeFileSync(path.join(at, file), await png(c, 100 + i * 20, 80));
  }
  process.env.META_API_KEY ??= 'meta-test-key-0123456789';
  studio = await startStudio({ root, bin: FAKE });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  if (studio) await studio.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test('no screen or state scrolls the page', async () => {
  if (!browser) return console.warn('studio-fold: no Chromium (npm run browsers), skipped');
  const spills: string[] = [];
  for (const [width, height] of SIZES) {
    for (const dock of DOCKS) {
      const ctx = await browser.newContext({ viewport: { width, height } });
      await ctx.addInitScript((d) => {
        const side = d === 'folded' ? 'right' : d;
        localStorage.setItem('diorama.dock', JSON.stringify({ side, width: 380, folded: d === 'folded', box: { x: 0, y: 80, w: 420, h: 620 } }));
      }, dock);
      const page = await ctx.newPage();
      // The page must not scroll, and in the Workshop neither may its content area or columns: there a spill is
      // either a fold or content cut off out of reach. The Start page may scroll inside its content area.
      const check = async (state: string, page_ = false) => {
        await page.waitForTimeout(250);
        const m = await page.evaluate((inner) => {
          const s = document.scrollingElement!;
          const over = inner ? [...document.querySelectorAll<HTMLElement>('#app > main, #app > main > .left, #app > main > .dock:not(.float)')].filter((e) => e.scrollHeight - e.clientHeight > 1 || e.scrollWidth - e.clientWidth > 1).map((e) => `${e.className} ${e.scrollWidth}x${e.scrollHeight} in ${e.clientWidth}x${e.clientHeight}`) : [];
          return { h: s.scrollHeight, w: s.scrollWidth, ih: innerHeight, iw: innerWidth, over };
        }, !page_);
        if (m.h > m.ih || m.w > m.iw) spills.push(`${width}x${height} dock=${dock} ${state}: page ${m.w}x${m.h}`);
        for (const o of m.over) spills.push(`${width}x${height} dock=${dock} ${state}: ${o}`);
      };
      const open = async (to: string) => {
        await page.goto(`${studio.url}${to.replace(/^\//, '')}#${studio.token}`);
        await page.waitForSelector('#app > main', { timeout: 10_000 });
        await page.waitForTimeout(600);
      };
      await open('/w/farm');
      await check('places');
      await page.locator('.strip .card').nth(1).dispatchEvent('click');
      await check('picked place');
      await page.locator('.strip .card').nth(1).dispatchEvent('click');
      for (const tab of ['Story', 'Cast', 'Notes']) {
        await page.getByRole('tab', { name: tab }).dispatchEvent('click');
        await check(tab);
      }
      await page.getByRole('tab', { name: 'Places' }).dispatchEvent('click');
      const play = page.getByRole('button', { name: 'Play', exact: true });
      if (await play.count()) {
        await play.dispatchEvent('click');
        await check('play');
        await page.getByRole('button', { name: 'Close game' }).dispatchEvent('click');
      }
      // Pages and overlays are the same at every dock: once per size.
      if (dock === 'right') {
        const history = page.getByRole('button', { name: 'History' });
        if (await history.count()) (await history.dispatchEvent('click'), await check('history'), await page.keyboard.press('Escape'));
        const activity = page.getByRole('button', { name: 'Activity' });
        if (await activity.count()) (await activity.dispatchEvent('click'), await check('activity'), await page.keyboard.press('Escape'));
        await open('/');
        await check('start', true);
        await open('/setup');
        await check('setup');
      }
      await ctx.close();
    }
  }
  expect(spills).toEqual([]);
}, 300_000);
