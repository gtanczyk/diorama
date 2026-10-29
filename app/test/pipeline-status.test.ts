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
    expect(await page.locator('.pipeline').innerText()).toContain('Earlier build shown in muted green');
    expect(await page.locator('.phases li.existing .label').first().getAttribute('title')).toContain('previous build');
    await run({ ...job, label: 'voices', args: ['voices'] }, { ...live, plan: ['voices'], done: {}, running: { voices: 'run' }, since: { voices: Date.now() - 500 } });
    expect(await page.locator('.phases li.existing .name').allTextContents()).toContain('Story');
    expect(await page.locator('.phases li.run .name').allTextContents()).toContain('Sound');
    const sound = page.locator('.phases li.run');
    expect(await sound.locator('.fill.existing').count()).toBe(1);
    expect(await sound.locator('.fill.run').count()).toBe(1);
    expect(await sound.locator('.label').getAttribute('title')).toContain('sound (previous build)');
  } finally { await browser.close(); }
}, 30_000);
