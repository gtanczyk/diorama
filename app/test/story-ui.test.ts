import { build } from 'esbuild';
import { chromium } from 'playwright';
import { expect, test } from 'vitest';

test('missing story assets ask the agent to review costs without starting generation', async () => {
  const source = (await build({
    stdin: { contents: `import { h, render } from 'preact'; import { StoryView } from './app/studio/story.tsx';
      render(h(StoryView, {slug:'w', version:0, onError:message => window.lastError = message}), document.body);`, resolveDir: process.cwd() },
    bundle: true, format: 'iife', write: false, jsx: 'automatic', jsxImportSource: 'preact',
  })).outputFiles[0].text;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const requests: { path: string; body: { text?: string } }[] = [];
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    let fail = false;
    await page.route('http://story.test/**', (r) => {
      const path = new URL(r.request().url()).pathname;
      if (path.startsWith('/api/')) requests.push({ path, body: r.request().postDataJSON() });
      if (path === '/api/actions/story_status') return r.fulfill({ json: { result: {
        start: 'garden', hero: 'hero', places: [{ key: 'garden', shows: 'A garden', exits: [], things: [] }],
        story: { intro: '', items: [], locks: [], interactions: [], dialogues: [], changes: [], endings: [] },
        fixes: { texts: {} }, issues: [], states: 1, routes: [], long: [], unvoiced: ['Hello'], unpainted: [0],
      } } });
      if (path === '/api/agent/w/say') return r.fulfill({ status: fail ? 503 : 200, json: fail ? { error: 'Agent unavailable' } : {} });
      return r.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' });
    });
    await page.goto('http://story.test');
    await page.addScriptTag({ content: source });
    const voices = page.getByRole('button', { name: 'Ask agent about 1 missing voice', exact: true });
    const paintings = page.getByRole('button', { name: 'Ask agent about 1 unpainted change', exact: true });
    await voices.click();
    await page.getByRole('status').waitFor();
    await paintings.click();
    await page.getByRole('status').waitFor();
    expect(requests.map((r) => r.path)).toEqual(['/api/actions/story_status', '/api/agent/w/say', '/api/agent/w/say']);
    expect(requests[1].body.text).toContain('spoken audio');
    expect(requests[2].body.text).toContain('painted changes');
    for (const request of requests.slice(1)) {
      expect(request.body.text).toContain('story_status');
      expect(request.body.text).toContain('estimated generation cost');
      expect(request.body.text).toContain('ask me to confirm before making any paid generation calls');
    }
    fail = true;
    await voices.click();
    await page.waitForFunction(() => (window as unknown as { lastError?: string }).lastError === 'Agent unavailable');
    expect(await voices.isEnabled()).toBe(true);
    expect(await page.getByRole('status').count()).toBe(0);
    expect(errors).toEqual([]);
  } finally { await browser.close(); }
}, 30_000);
