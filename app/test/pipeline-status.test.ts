import { build } from 'esbuild';
import { chromium } from 'playwright';
import { expect, test } from 'vitest';

test('progress shows the current extension milestone instead of old build results', async () => {
  const source = (await build({ stdin: { contents: `import { h, render } from 'preact';
    import { Pipeline } from './app/studio/build.tsx';
    window.show = (job, live) => render(h(Pipeline, {job, live, all:['world','story','layout','paint','masks','sound','voices','verify'], build:{world:{seconds:1},story:{seconds:1},layout:{seconds:1},paint:{seconds:1},masks:{seconds:1},sound:{seconds:1},voices:{seconds:1},verify:{seconds:1}}, typical:{}}), document.body);`, resolveDir: process.cwd() }, bundle: true, format: 'iife', write: false, jsx: 'automatic', jsxImportSource: 'preact' })).outputFiles[0].text;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    await page.addScriptTag({ content: source });
    const run = (job: object, live: object) => page.evaluate(({ job, live }) => (window as unknown as { show: (job: object, live: object) => void }).show(job, live), { job, live });
    const live = { plan: ['layout', 'paint', 'masks', 'verify'], done: { layout: 1, paint: 1, masks: 1 }, running: { masks: 'run' }, since: {}, calls: {}, lastCall: null, cut: {}, tail: '' };
    const job = { by: 'agent', state: 'running', label: 'extend world', args: ['extend'] };
    await run(job, live);
    expect(await page.locator('.extension-pipeline .ok').count()).toBe(0);
    expect(await page.locator('.extension-pipeline').innerText()).toContain('Working: masks');
    await run(job, { ...live, extension: { phase: 'places', index: 2, total: 2, place: 'triangle-house' } });
    expect(await page.locator('.extension-pipeline .ok').count()).toBe(1);
    expect(await page.locator('.extension-pipeline .run').count()).toBe(1);
    expect(await page.locator('.extension-pipeline').innerText()).toContain('Place 2 of 2: triangle-house · masks');
    expect(await page.locator('.extension-pipeline').innerText()).toContain('current world');
    expect(await page.locator('.extension-pipeline .todo').count()).toBe(2);
    await run({ ...job, state: 'failed', extension: { phase: 'places' } }, { ...live, extension: undefined });
    expect(await page.locator('.extension-pipeline .fail').count()).toBe(1);
    expect(await page.locator('.extension-pipeline').innerText()).toContain('Build did not finish');
    await run({ ...job, args: ['build'] }, live);
    expect(await page.locator('.phases li.run .name').allTextContents()).toContain('Cut out');
    expect(await page.locator('.phases li.existing .name').allTextContents()).toContain('Story');
    expect(await page.locator('.pipeline').innerText()).toContain('faded green: kept from the earlier build');
    expect(await page.locator('.phases li.existing .label').first().getAttribute('title')).toContain('previous build');
    await run({ ...job, label: 'voices', args: ['voices'] }, { ...live, plan: ['voices'], done: {}, running: { voices: 'run' }, since: { voices: Date.now() - 500 } });
    expect(await page.locator('.phases li.existing .name').allTextContents()).toContain('Story');
    expect(await page.locator('.phases li.run .name').allTextContents()).toContain('Sound');
    const sound = page.locator('.phases li.run');
    expect(await sound.locator('.fill.existing').count()).toBe(1);
    expect(await sound.locator('.fill.run').count()).toBe(1);
    expect(await sound.locator('.label').getAttribute('title')).toContain('Sounds (previous build)');
  } finally { await browser.close(); }
}, 30_000);

// Grzegorz: no "lips missing" chip on the build screen. Talking faces are optional: a face not ready is no problem
// colour on the bar; the faces segment says who talks with gestures, and opens the faces view.
test('an optional face not ready is no build problem: green bar, no chip, the faces segment says who', async () => {
  const source = (await build({ stdin: { contents: `import {h,render} from 'preact'; import {Pipeline} from './app/studio/build.tsx';
    render(h(Pipeline,{all:['faces','verify'],live:{plan:[],done:{faces:2,verify:1},running:{},since:{},calls:{},lastCall:null,cut:{},tail:''},build:{faces:{seconds:2,status:'incomplete',warnings:['dozorca: F/V needs review']},verify:{seconds:1}},typical:{},onOpen:(phase,step)=>window.opened=[phase,step]}),document.body);`, resolveDir: process.cwd() }, bundle: true, format: 'iife', write: false, jsx: 'automatic', jsxImportSource: 'preact' })).outputFiles[0].text;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage(); await page.goto('about:blank'); await page.addScriptTag({ content: source });
    expect(await page.locator('.phases li.ok .name').allTextContents()).toEqual(['Cast', 'Checks']);
    expect(await page.locator('.fill.warn, .phases .fail, .speech-chip').count()).toBe(0);
    const faces = page.locator('.seg[title^="Talking faces"]');
    expect(await faces.getAttribute('title')).toContain('Optional: dozorca talk with gestures');
    await faces.click();
    expect(await page.evaluate(() => (window as unknown as { opened: string[] }).opened)).toEqual(['cast', 'faces']);
  } finally { await browser.close(); }
}, 30_000);

test('a step that set a place aside is not plain green and says which place', async () => {
  const source = (await build({ stdin: { contents: `import { h, render } from 'preact';
    import { Pipeline } from './app/studio/build.tsx';
    window.show = (job, live) => render(h(Pipeline, {job, live, all:['layout','paint','masks'], build:{}, typical:{}, onOpen: () => {}}), document.body);`, resolveDir: process.cwd() }, bundle: true, format: 'iife', write: false, jsx: 'automatic', jsxImportSource: 'preact' })).outputFiles[0].text;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    await page.addScriptTag({ content: source });
    const live = { plan: ['layout', 'paint', 'masks'], done: { layout: 1, paint: 1 }, running: { masks: 'run' }, since: {}, calls: {}, lastCall: null, cut: {}, tail: '', aside: { 'lower-stands': 'paint' } };
    await page.evaluate((live) => (window as unknown as { show: (j: object, l: object) => void }).show({ by: 'you', state: 'running', label: 'build', args: ['build'] }, live), live);
    expect(await page.locator('.fill.warn').count()).toBe(1);
    expect(await page.locator('.fill.ok').count()).toBe(1);
    const titles = await page.locator('.seg').evaluateAll((s) => s.map((b) => b.getAttribute('title')));
    expect(titles.find((t) => t?.startsWith('Painting'))).toContain('failed for lower-stands');
    expect(titles.find((t) => t?.startsWith('Plan sketch'))).toContain('Click to see the plan sketch');
  } finally {
    await browser.close();
  }
});
