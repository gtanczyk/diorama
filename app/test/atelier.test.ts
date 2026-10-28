import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { startStudio, type Studio } from '../src/studio/server.ts';
import { scene } from './fixtures/scene.ts';

let root: string, studio: Studio, browser: Browser;
let masksA: object, masksB: object;
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-atelier-'));
  const { world, geometry, notes, put } = await scene(root, false, ['room-a', 'room-b']);
  world.places[1].things[0].key = 'blue-key'; put('world.json', world);
  masksA = notes;
  masksB = { ...notes, things: { 'blue-key': { ...notes.things.token, box: [600, 300, 800, 500] } } };
  put('places/room-b/masks.json', masksB);
  put('places/room-b/geometry.json', { ...geometry, things: [{ ...geometry.things[0], key: 'blue-key', box: [600, 300, 800, 500], coarse: true }] });
  put('build.json', { steps: { story: {}, verify: {} } });
  put('studio/feedback.json', Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, at: new Date().toISOString(), by: 'user', text: `Audit note ${i + 1}`, state: i === 4 ? 'done' : 'open', ...(i === 4 && { reply: 'Fixed by hand' }) })));
  studio = await startStudio({ root, bin: fileURLToPath(new URL('./fixtures/fake-diorama.mjs', import.meta.url)), muse: fileURLToPath(new URL('./fixtures/fake-muse.mjs', import.meta.url)) });
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => { await browser?.close(); await studio?.close(); if (root) fs.rmSync(root, { recursive: true, force: true }); });
const open = async (page: Page) => { await page.goto(`${studio.url}w/w#${studio.token}`); await page.locator('.convo header h1').waitFor(); };

test('a late mask response cannot change the new place or the object sent to the agent', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  let release!: () => void, entered!: () => void, finished!: () => void;
  const hold = new Promise<void>((r) => release = r), request = new Promise<void>((r) => entered = r), done = new Promise<void>((r) => finished = r);
  await page.route('**/places/room-a/masks.json*', async (r) => { entered(); await hold; try { await r.fulfill({ json: masksA }); } finally { finished(); } });
  await page.route('**/places/room-b/masks.json*', (r) => r.fulfill({ json: masksB }));
  const sent: Array<{ text: string }> = [];
  await page.route('**/api/agent/w/say', async (r) => { sent.push(r.request().postDataJSON()); await r.fulfill({ json: {} }); });
  try {
    await open(page); await request;
    await page.locator('.wcard .thumb').nth(1).click();
    await page.getByRole('button', { name: 'Talk about the blue key', exact: true }).waitFor();
    release(); await done;
    // A fresh request settles the browser task queue after the delayed response.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    expect(await page.getByRole('button', { name: 'Talk about the token', exact: true }).count()).toBe(0);
    await page.getByRole('button', { name: 'Talk about the blue key', exact: true }).click();
    await page.locator('section.agent textarea').fill('Change this'); await page.locator('section.agent textarea').press('Enter');
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].text).toBe('[Looking at: room-b / blue-key]\nChange this');
  } finally { release(); await page.close(); }
}, 30_000);

test('all open and closed notes are accessible and can be closed, reopened and added by hand', async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  try {
    await open(page); await page.getByRole('button', { name: 'All notes', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Notes', exact: true });
    expect(await dialog.innerText()).toContain('Audit note 4'); expect(await dialog.innerText()).toContain('Fixed by hand');
    await dialog.locator('li', { hasText: 'Audit note 1' }).getByRole('button', { name: 'Done', exact: true }).click();
    await dialog.locator('li', { hasText: 'Audit note 1' }).getByRole('button', { name: 'Reopen', exact: true }).waitFor();
    await dialog.locator('li', { hasText: 'Audit note 1' }).getByRole('button', { name: 'Reopen', exact: true }).click();
    await dialog.locator('li', { hasText: 'Audit note 1' }).getByRole('button', { name: 'Done', exact: true }).waitFor();
    await dialog.locator('input').fill('A new note from the world'); await dialog.getByRole('button', { name: 'Add', exact: true }).click();
    await expect.poll(() => dialog.innerText()).toContain('A new note from the world');
    const m = await page.evaluate(() => ({ page: document.scrollingElement!.scrollHeight, height: innerHeight })); expect(m.page).toBe(m.height);
  } finally { await page.close(); }
}, 30_000);

test('the manual place inspector shows current verifier flags', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  try {
    await open(page); await page.locator('.wcard .thumb').nth(1).click();
    await page.getByRole('button', { name: '✎ Fix this place by hand', exact: true }).click();
    await expect.poll(() => page.getByRole('region', { name: 'Place checks' }).innerText()).toContain('COARSE_MASK');
  } finally { await page.close(); }
}, 30_000);

test('an acknowledged completion stays read after a page reload', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  try {
    await open(page);
    const job = studio.jobs.start('w', ['test', 'w'], 'Notification test', 'user'); await studio.jobs.wait(job.id);
    await expect.poll(() => page.locator('.bell').getAttribute('aria-label')).toBe('Notifications: 1');
    await page.locator('.bell').click(); await page.locator('.bell-item.done').click();
    await expect.poll(() => page.locator('.bell').getAttribute('aria-label')).toBe('Notifications');
    await page.reload(); await page.locator('.convo header h1').waitFor();
    await expect.poll(() => page.locator('.bell').getAttribute('aria-label')).toBe('Notifications');
  } finally { await page.close(); }
}, 30_000);
