// Studio never scrolls as a page (Grzegorz: "nie chcę foldów w tej appce"): every screen and state, at three window
// sizes, fits the window; long content scrolls inside its own panel.
import sharp from 'sharp';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startStudio, type Studio } from '../src/studio/server.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-diorama.mjs', import.meta.url));
const SIZES = [[1000, 700], [1440, 860], [1920, 1080]] as const;
const LONG = 'a wide sunny farm yard seen slightly from above, open dirt ground in front for walking, low wooden fences along both sides, a large red barn with a wide wooden door at the back, a wooden cart with golden hay and a blue water pump nearby, green meadow and blue sky beyond';

type Browser = import('playwright').Browser;
let browser: Browser | null = null;
let studio: Studio;
let root: string;

const png = (r: number, g: number, b: number) => sharp({ create: { width: 1200, height: 896, channels: 3, background: { r, g, b } } }).png().toBuffer();

beforeAll(async () => {
  browser = await (await import('playwright')).chromium.launch();
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
  if (!browser) throw new Error('Chromium is required: npm run browsers');
  const spills: string[] = [];
  for (const [width, height] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width, height } });
    const page = await ctx.newPage();
    // The page must not scroll, and in a world neither may the page, the conversation or the stage: there a spill
    // is either a fold or content cut off out of reach. The conversation and the rail scroll inside their lists.
    const check = async (state: string) => {
      await page.waitForTimeout(250);
      const m = await page.evaluate(() => {
        const s = document.scrollingElement!;
        const over = [...document.querySelectorAll<HTMLElement>('.atelier, .atelier-page > main.world, main.world > .convo, main.world > .theatre')].filter((e) => e.scrollHeight - e.clientHeight > 1 || e.scrollWidth - e.clientWidth > 1).map((e) => `${e.className} ${e.scrollWidth}x${e.scrollHeight} in ${e.clientWidth}x${e.clientHeight}`);
        return { h: s.scrollHeight, w: s.scrollWidth, ih: innerHeight, iw: innerWidth, over };
      });
      if (m.h > m.ih || m.w > m.iw) spills.push(`${width}x${height} ${state}: page ${m.w}x${m.h}`);
      for (const o of m.over) spills.push(`${width}x${height} ${state}: ${o}`);
    };
    const open = async (to: string) => {
      await page.goto(`${studio.url}${to.replace(/^\//, '')}#${studio.token}`);
      await page.waitForSelector('.atelier-page > main', { timeout: 10_000 });
      await page.waitForTimeout(600);
    };
    await open('/');
    await check('atelier');
    await open('/w/farm');
    await check('place');
    await page.locator('.wcard .thumb').nth(1).dispatchEvent('click');
    await check('second place');
    await page.locator('.wcard .thumb').last().dispatchEvent('click');
    await check('unpainted place');
    for (const card of ['Story', 'Cast']) {
      const c = page.locator('.wcard.click', { hasText: card });
      if (await c.count()) (await c.first().dispatchEvent('click'), await check(card));
    }
    const play = page.getByRole('button', { name: '▶ Play' });
    if (await play.count()) {
      await play.first().dispatchEvent('click');
      await check('play');
      await page.getByRole('button', { name: 'Close game' }).dispatchEvent('click');
    }
    await page.locator('.bell').dispatchEvent('click');
    await check('bell');
    await page.keyboard.press('Escape');
    // The place editor's drawer scrolls inside; none of its rows (the tool tabs) is squeezed shorter than its content.
    const fix = page.locator('.stage-tool');
    if (await fix.count()) {
      await fix.first().dispatchEvent('click');
      await page.locator('.drawer .editor .tools').waitFor();
      await check('by hand');
      const squeezed = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.drawer .editor > *')].filter((e) => e.scrollHeight - e.clientHeight > 2 && getComputedStyle(e).overflowY !== 'auto').map((e) => `${e.className} ${e.clientHeight}<${e.scrollHeight}`));
      if (squeezed.length) spills.push(`${width}x${height} by hand: squeezed ${squeezed.join(', ')}`);
      await page.keyboard.press('Escape');
    }
    for (const item of ['History', 'Activity', /by hand/]) {
      await page.locator('.menu-button').dispatchEvent('click');
      const b = page.locator('.top-menu').getByRole('button', { name: item });
      if (await b.count()) (await b.first().dispatchEvent('click'), await check(String(item)), await page.keyboard.press('Escape'));
      else await page.keyboard.press('Escape');
    }
    await open('/setup');
    await check('setup');
    await ctx.close();
  }
  expect(spills).toEqual([]);
}, 300_000);
