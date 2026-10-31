import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { startStudio, type Studio } from '../src/studio/server.ts';
import { scene } from './fixtures/scene.ts';
import { MAX_WORLD_PHOTOS } from '../src/world/photo-limits.ts';

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

test.each([true, false])('deleting a world removes its rail entry without reloading (live feed: %s)', async (live) => {
  const slug = live ? 'delete-live' : 'delete-offline';
  fs.cpSync(path.join(root, 'w'), path.join(root, slug), { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  page.setDefaultTimeout(8000);
  if (!live) await page.route('**/api/events?*', (r) => r.abort());
  try {
    await page.goto(`${studio.url}w/${slug}#${studio.token}`);
    const entry = page.locator(`.rail-world[href="/w/${slug}"]`);
    await entry.waitFor();
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('button', { name: 'Delete this world…', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByRole('textbox').fill(slug);
    await dialog.getByRole('button', { name: 'Delete this world', exact: true }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/');
    await expect.poll(() => entry.count()).toBe(0);
    expect(await page.locator('.rail-world[href="/w/w"]').count()).toBe(1);
    expect(fs.existsSync(path.join(root, slug))).toBe(false);
  } finally { await page.close(); }
}, 30_000);

test('a deletion in another tab updates the rail and a stale list cannot bring the world back', async () => {
  const slug = 'delete-elsewhere';
  fs.cpSync(path.join(root, 'w'), path.join(root, slug), { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  page.setDefaultTimeout(8000);
  let release!: () => void, entered!: () => void, finished!: () => void;
  const hold = new Promise<void>((r) => release = r), request = new Promise<void>((r) => entered = r), done = new Promise<void>((r) => finished = r);
  try {
    await open(page);
    const entry = page.locator(`.rail-world[href="/w/${slug}"]`);
    await entry.waitFor();
    await page.route('**/api/actions/world_list', async (r) => {
      const response = await r.fetch();
      entered(); await hold;
      try { await r.fulfill({ response }); } finally { finished(); }
    }, { times: 1 });
    studio.events.publish('step.end', { world: 'w', step: 'test' });
    await request;
    const response = await page.request.post(`${studio.url}api/actions/world_delete`, {
      headers: { authorization: `Bearer ${studio.token}` }, data: { slug },
    });
    expect(response.ok()).toBe(true);
    await expect.poll(() => entry.count()).toBe(0);
    release(); await done;
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    expect(await entry.count()).toBe(0);
    expect(await page.locator('.rail-world[href="/w/w"]').count()).toBe(1);
    expect(new URL(page.url()).pathname).toBe('/w/w');
  } finally { release(); await page.close(); }
}, 30_000);

test('Setup returns to the world that opened it, including after reload and browser navigation', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  try {
    await open(page);
    await page.getByRole('button', { name: 'More' }).click();
    await page.getByRole('link', { name: 'Setup', exact: true }).click();
    await page.getByRole('link', { name: 'Back to world' }).waitFor();
    await page.reload();
    await page.getByRole('link', { name: 'Back to world' }).click();
    await page.locator('.convo header h1').waitFor();
    expect(new URL(page.url()).pathname).toBe('/w/w');
    await page.goForward();
    await page.getByRole('link', { name: 'Back to world' }).waitFor();
    await page.goBack();
    await page.locator('.convo header h1').waitFor();
    await page.goto(`${studio.url}setup`);
    await page.getByRole('link', { name: 'Back to Studio' }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  } finally { await page.close(); }
}, 30_000);

test('the start form sends all 18 drawings in order and never silently drops excess attachments', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(8000);
  const sent: Array<{ photos: Array<{ name: string; data: string }> }> = [];
  await page.route('**/api/actions/setup_status', (r) => r.fulfill({ json: { result: [] } }));
  await page.route('**/api/actions/idea_review', (r) => r.fulfill({ json: { result: { understanding: 'A story from drawings', questions: [{ question: 'Who should lead?', why: '', options: [] }], styles: [] } } }));
  await page.route('**/api/actions/world_new', async (r) => {
    sent.push(r.request().postDataJSON());
    // Keep the form open; this test must never call a live model or build a world.
    await r.fulfill({ status: 400, json: { error: 'Test: no build started' } });
  });
  const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
  const files = (count: number, from = 1) => Array.from({ length: count }, (_, i) => ({ name: `drawing-${from + i}.png`, mimeType: 'image/png', buffer: photo }));
  try {
    await page.goto(`${studio.url}#${studio.token}`);
    await page.getByRole('button', { name: 'Video', exact: true }).waitFor();
    expect(await page.getByLabel('Choose a video').isVisible()).toBe(false);
    await page.screenshot({ path: '/tmp/diorama-start-video.png' });
    await page.getByRole('textbox', { name: 'Your idea' }).fill('Make a story from these drawings');
    const picker = page.locator('form.hero input[type=file][accept="image/*"]');
    const build = page.getByRole('button', { name: 'Build it', exact: true });
    await picker.setInputFiles(files(18));
    await expect.poll(() => page.locator('.attached .att').count()).toBe(18);
    await expect.poll(() => build.isEnabled()).toBe(true);
    await build.click();
    await page.getByRole('region', { name: 'Shape your world' }).waitFor();
    expect(await page.getByRole('dialog').count()).toBe(0);
    expect(await page.getByRole('textbox', { name: 'Your idea' }).isVisible()).toBe(false);
    expect(sent).toHaveLength(0);
    await page.getByRole('button', { name: 'Skip & build', exact: true }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].photos.map((p) => p.name)).toEqual(files(18).map((p) => p.name.replace('.png', '.jpg')));
    await page.getByRole('button', { name: 'Back to idea', exact: true }).click();
    await expect.poll(() => build.isEnabled()).toBe(true);

    await picker.setInputFiles(files(MAX_WORLD_PHOTOS + 1 - 18, 19));
    await expect.poll(() => page.locator('.attached .att').count()).toBe(MAX_WORLD_PHOTOS + 1);
    await expect.poll(() => page.getByRole('alert').innerText()).toContain('Remove 1 to continue');
    expect(await build.isEnabled()).toBe(false);
    expect(sent).toHaveLength(1);
    await page.getByRole('button', { name: 'Remove the photo', exact: true }).last().click();
    await expect.poll(() => build.isEnabled()).toBe(true);
    expect(await page.locator('.attached .att').count()).toBe(MAX_WORLD_PHOTOS);
    expect(await page.getByRole('alert').count()).toBe(0);
  } finally { await page.close(); }
}, 30_000);

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
    await page.getByRole('button', { name: 'Fix this place by hand', exact: true }).click();
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

test('a finished job can be dismissed from the bell with its cross and stays dismissed after a reload', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  try {
    await open(page);
    const job = studio.jobs.start('w', ['test', 'w'], 'Dismiss test', 'user'); await studio.jobs.wait(job.id);
    await expect.poll(() => page.locator('.bell').getAttribute('aria-label')).toBe('Notifications: 1');
    await page.locator('.bell').click(); await page.locator('.bell-x').first().click();
    await expect.poll(() => page.locator('.bell').getAttribute('aria-label')).toBe('Notifications');
    expect(await page.locator('.bell-pop').isVisible()).toBe(true);
    await page.reload(); await page.locator('.convo header h1').waitFor();
    await expect.poll(() => page.locator('.bell').getAttribute('aria-label')).toBe('Notifications');
  } finally { await page.close(); }
}, 30_000);

test.each([true, false])('opening keeps the creator idea separate from model instructions (reviewed: %s)', async reviewed => {
  const slug = reviewed ? 'reviewed-opening' : 'legacy-opening';
  const dir = path.join(root, slug);
  fs.cpSync(path.join(root, 'w'), dir, { recursive: true });
  const idea = 'A night market where paper lanterns hold lost memories, and one lantern has gone dark';
  const instruction = "Creator's clarifications (these override earlier ambiguity; keep the original story language unless explicitly changed):";
  const style = 'Warm hand-inked night market on textured rice paper, deep indigo shadows and glowing amber lanterns.';
  fs.writeFileSync(path.join(dir, 'idea.txt'), reviewed ? `${idea}\n\n${instruction}\nWho do you play?\nThe lantern keeper\nVisual style chosen by the creator: ${style}` : 'A quiet lighthouse beside a stormy sea.');
  if (reviewed) fs.writeFileSync(path.join(dir, 'creative-brief.json'), JSON.stringify({ idea, choices: { answers: [{ question: 'Who do you play?', answer: 'The lantern keeper' }, { question: 'Whose memory is in the dark lantern?', answer: 'Your own' }], style } }));
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  try {
    await page.goto(`${studio.url}w/${slug}#${studio.token}`);
    const bubble = page.locator('.creator-idea .idea-bubble');
    await bubble.waitFor();
    expect(await bubble.textContent()).toBe(reviewed ? idea : 'A quiet lighthouse beside a stormy sea.');
    expect(await page.locator('.creator-idea').textContent()).not.toContain(instruction);
    const choices = page.locator('.creator-choices');
    if (reviewed) {
      expect(await choices.getAttribute('open')).toBeNull();
      await choices.locator('summary').click();
      expect(await choices.locator('dd').allTextContents()).toEqual(['The lantern keeper', 'Your own', style]);
      await page.locator('.convo .gc-scroll').evaluate(e => e.scrollTop = 0);
      await page.locator('.convo').screenshot({ path: '/tmp/diorama-clean-opening.png' });
      expect(fs.readFileSync(path.join(dir, 'idea.txt'), 'utf8')).toContain(instruction);
    } else expect(await choices.count()).toBe(0);
  } finally { await page.close(); }
});

test('Build lets the creator watch a place through updates and resume automatic following', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.route('**/api/actions/world_status', async r => {
      const response = await r.fetch(), body = await response.json();
      body.result.jobs = [{ id: 'watch-build', state: 'running', by: 'user', label: 'build world > verify', args: ['build', 'w'], startedAt: new Date().toISOString(), createdAt: new Date().toISOString() }];
      await r.fulfill({ response, json: body });
    });
    await open(page);
    const nav = page.getByRole('navigation', { name: 'Build places' });
    await nav.waitFor();
    await nav.getByRole('button', { name: 'Room b', exact: true }).click();
    expect(await page.locator('.stage-top h2').textContent()).toBe('Room b');
    expect(await nav.getByRole('button', { name: 'Follow build' }).getAttribute('aria-pressed')).toBe('false');
    await nav.getByRole('button', { name: 'Room a', exact: true }).click();
    studio.events.publish('file.changed', { world: 'w', file: 'places/room-b/painting.png', exists: true });
    // A live update and the build's rotation timer must not replace a manually watched place.
    await page.waitForTimeout(4700);
    expect(await page.locator('.stage-top h2').textContent()).toBe('Room a');
    expect(await page.locator('.stage-body.build').count()).toBe(1);
    await nav.getByRole('button', { name: 'Follow build' }).click();
    await expect.poll(() => page.locator('.stage-top h2').textContent()).toBe('Room b');
    expect(await nav.getByRole('button', { name: 'Follow build' }).getAttribute('aria-pressed')).toBe('true');
    await page.screenshot({ path: '/tmp/diorama-build-places.png' });
  } finally { await page.close(); }
}, 15000);

test.each([true, false])('Story opened from Build returns to Build and its watched place (running: %s)', async running => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(3500);
  try {
    await page.route('**/api/actions/world_status', async r => {
      const response = await r.fetch(), body = await response.json();
      body.result.jobs = running ? [{ id: 'story-build', state: 'running', by: 'user', label: 'build world > verify', args: ['build', 'w', '--from', 'masks'], startedAt: new Date().toISOString(), createdAt: new Date().toISOString() }] : [];
      body.result.build = { ...body.result.build, story: { seconds: 1 }, paint: { seconds: 1 } };
      await r.fulfill({ response, json: body });
    });
    await open(page);
    // Reproduce an older Places visit before opening the Build inspector.
    await page.locator('.convo .thumb:is([title^="Room a:"], [data-tip^="Room a:"])').click();
    await page.locator('.stage-body.place').waitFor();
    await page.locator('.convo .to-build').click();
    const nav = page.getByRole('navigation', { name: 'Build places' });
    await nav.getByRole('button', { name: 'Room b', exact: true }).click();
    const story = () => page.locator('.stage-body .pipeline button.label').filter({ hasText: 'Story' });
    await story().click();
    await page.locator('.stage-body.story .paper-panel').waitFor();
    expect(await page.locator('.stage-body.story .pipeline').count()).toBe(1);
    expect(await page.getByRole('button', { name: 'Back', exact: true }).getAttribute('title')).toBe('Back to the build (Esc)');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.locator('.stage-body.build').waitFor();
    expect(await page.locator('.stage-top h2').textContent()).toBe('Room b');
    await story().click();
    await page.locator('.stage-body.story').waitFor();
    await page.waitForTimeout(150); // Let the view's Escape listener attach after paint.
    await page.keyboard.press('Escape');
    await page.locator('.stage-body.build').waitFor();
    expect(await page.locator('.stage-top h2').textContent()).toBe('Room b');
    await story().click();
    await page.locator('.stage-body.story .story').waitFor();
    await page.screenshot({ path: `/tmp/diorama-build-story-${running}.png` });
    await page.locator('.stage-body .pipeline button.label').filter({ hasText: 'Paint' }).click();
    await page.locator('.stage-body.build').waitFor();
    expect(await page.locator('.stage-top h2').textContent()).toBe('Room b');
    // The ordinary Story card still returns to Places when opened from there.
    await page.locator('.convo .thumb:is([title^="Room a:"], [data-tip^="Room a:"])').click();
    await page.locator('.convo [data-opening="story"]').click();
    await page.locator('.stage-body.story .paper-panel').waitFor();
    expect(await page.locator('.stage-body.story .pipeline').count()).toBe(0);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.locator('.stage-body.place').waitFor();
    expect(await page.locator('.stage-top h2').textContent()).toBe('Room a');
  } finally { await page.close(); }
}, 15000);
