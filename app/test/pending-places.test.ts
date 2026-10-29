import { build } from 'esbuild';
import { chromium } from 'playwright';
import { expect, test } from 'vitest';

test('a new place stays visibly provisional until it joins the real world', async () => {
  const source = (await build({ stdin: { contents: `import { h, render } from 'preact';
    import { PlacesCard, WorldStrip } from './app/studio/world.tsx';
    const active = {key:'castle',shows:'A castle',image:null,stages:{},verdict:{ok:true}};
    window.show = pending => render(h('div', null,
      h(WorldStrip,{slug:'w',version:0,title:'World',places:[active],pending,stage:{kind:'place',place:'castle'},onStage:s=>window.opened=s.kind}),
      h(PlacesCard,{slug:'w',places:[active],pending,stage:{kind:'place',place:'castle'},onStage:s=>window.opened=s.kind})),document.body);`, resolveDir: process.cwd() }, bundle: true, format: 'iife', write: false, jsx: 'automatic', jsxImportSource: 'preact' })).outputFiles[0].text;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('http://world.test/**', route => route.request().url().includes('/api/') ? route.fulfill({ json: { result: [] } }) : route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
    await page.goto('http://world.test');
    await page.addScriptTag({ content: source });
    await page.evaluate(() => (window as unknown as { show: (p: string[]) => void }).show(['triangle-house-scene']));
    const draft = page.getByRole('button', { name: 'Triangle house scene: being built, not in the game yet' });
    expect(await draft.count()).toBe(1);
    expect(await page.locator('.pending-place').innerText()).toContain('Building');
    await draft.click();
    expect(await page.evaluate(() => (window as unknown as { opened: string }).opened)).toBe('build');
    await page.evaluate(() => (window as unknown as { show: (p: string[]) => void }).show([]));
    expect(await draft.count()).toBe(0);
    expect(await page.locator('.pending-place').count()).toBe(0);
  } finally { await browser.close(); }
}, 30_000);
