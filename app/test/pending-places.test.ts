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
    const stack = page.getByRole('button', { name: '1 place, 1 building. Show places in the conversation' });
    expect(await stack.count()).toBe(1);
    expect(await stack.innerText()).toContain('+1');
    expect(await page.locator('.pending-place').innerText()).toContain('Building');
    await page.locator('.pending-place').click();
    expect(await page.evaluate(() => (window as unknown as { opened: string }).opened)).toBe('build');
    await page.evaluate(() => (window as unknown as { show: (p: string[]) => void }).show([]));
    expect(await page.getByRole('button', { name: '1 place. Show places in the conversation' }).count()).toBe(1);
    expect(await page.locator('.pending-place').count()).toBe(0);
  } finally { await browser.close(); }
}, 30_000);

test('the compact previews keep the cast visible and scroll to the matching card', async () => {
  const source = (await build({ stdin: { contents: `import { h, render } from 'preact';
    import { CastCard, PlacesCard, WorldStrip } from './app/studio/world.tsx';
    const places = Array.from({length: 12}, (_, i) => ({key:'place-'+i,shows:'A place',image:null,stages:{},verdict:{ok:true}}));
    const props = {slug:'w',version:0,stage:{kind:'place',place:'place-0'},onStage:s=>window.opened=s.kind};
    render(h('section',{class:'agent'},
      h(WorldStrip,{...props,title:'A world',places,castDone:true}),
      h('div',{class:'gc-scroll'}, h(PlacesCard,{...props,places}), h(CastCard,props), h('div',{style:'height:1200px'}))),document.body);`, resolveDir: process.cwd() }, bundle: true, format: 'iife', write: false, jsx: 'automatic', jsxImportSource: 'preact' })).outputFiles[0].text;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 500 }, reducedMotion: 'reduce' });
    await page.route('http://world.test/**', route => route.request().url().includes('/api/') ? route.fulfill({ json: { result: [{ key: 'hero', figure: { file: 'hero.png', v: 1 } }] } }) : route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
    await page.goto('http://world.test');
    await page.addStyleTag({ path: 'app/studio/style.css' });
    await page.addStyleTag({ content: '.agent { width: 300px; } .gc-scroll { height: 200px; overflow: auto; }' });
    await page.addScriptTag({ content: source });
    const cast = page.getByRole('button', { name: 'Show 1 character in the conversation' });
    await cast.waitFor();
    const fits = await page.evaluate(() => {
      const strip = document.querySelector('.world-strip')!.getBoundingClientRect();
      const cast = document.querySelector('.ws-cast')!.getBoundingClientRect();
      return cast.right <= strip.right;
    });
    expect(fits).toBe(true);
    expect(await page.locator('.ws-sheet').count()).toBe(3);
    await page.locator('.gc-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await cast.click();
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-opening'))).toBe('cast');
    expect(await page.locator('.gc-scroll').evaluate(el => el.scrollTop)).toBeLessThan(1200);
    await page.locator('.gc-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.getByRole('button', { name: '12 places. Show places in the conversation' }).click();
    expect(await page.evaluate(() => document.activeElement?.closest('[data-opening]')?.getAttribute('data-opening'))).toBe('places');
    expect(await page.locator('.gc-scroll').evaluate(el => el.scrollTop)).toBeLessThan(100);
  } finally { await browser.close(); }
}, 30_000);
