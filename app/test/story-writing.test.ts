import { build } from 'esbuild';
import { chromium } from 'playwright';
import { expect, test } from 'vitest';

test('while the story step writes, the Story view shows the places plan and each draft live', async () => {
  const source = (await build({
    stdin: { contents: `import { h, render } from 'preact'; import { StoryView } from './app/studio/story.tsx';
      window.show = (writing) => render(h(StoryView, {slug:'w', version:0, onError:() => {}, writing}), document.body);`, resolveDir: process.cwd() },
    bundle: true, format: 'iife', write: false, jsx: 'automatic', jsxImportSource: 'preact',
  })).outputFiles[0].text;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    await page.route('http://story.test/**', (r) => {
      if (new URL(r.request().url()).pathname === '/api/actions/story_status') return r.fulfill({ json: { result: {
        start: 'stands', hero: 'kid', places: [
          { key: 'stands', shows: 'Lower stands of a stadium, a tunnel at the back', exits: [{ to: 'snack-bar', via: 'tunnel' }], things: [{ key: 'flag', role: 'item' }] },
          { key: 'snack-bar', shows: 'A popcorn stall', exits: [{ to: 'stands', via: 'door' }], things: [{ key: 'popcorn-seller', role: 'npc' }] },
        ],
        story: null, fixes: { texts: {} }, issues: [], states: 0, routes: [], long: [], unvoiced: [], unpainted: [],
      } } });
      return r.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' });
    });
    await page.goto('http://story.test');
    await page.addScriptTag({ content: source });
    const show = (w: object | undefined) => page.evaluate((w) => (window as unknown as { show: (w?: object) => void }).show(w), w);
    await show(undefined);
    await page.getByText('popcorn stall').waitFor();
    expect(await page.locator('body').innerText()).toContain('not written yet');
    await show({ since: Date.now() - 95_000, log: [
      { at: 1, kind: 'call', by: 'Claude', text: 'draft 1 written' },
      { at: 2, kind: 'check', text: 'try 1: 2 issue(s): ending "home" is reached in only 3 clicks' },
      { at: 3, kind: 'call', by: 'Claude', text: 'draft 2 written' },
    ] });
    const text = await page.locator('.story-writing').innerText();
    expect(text).toContain('Writing the story · 1:3');
    expect(text).toContain('the checker plays it through');
    expect(text).toContain('Claude: draft 2 written');
    expect(text).toContain('checker: try 1: 2 issue(s)');
    expect(await page.locator('.plan-places li').count()).toBe(2);
    if (process.env.SHOT) (await page.addStyleTag({ path: 'app/studio/style.css' }), await page.screenshot({ path: process.env.SHOT }));
  } finally {
    await browser.close();
  }
});
