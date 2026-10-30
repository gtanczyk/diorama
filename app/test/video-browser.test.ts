import { build } from 'esbuild';
import { chromium } from 'playwright';
import { expect, test } from 'vitest';
test('movie upload shows progress, recovers from an analysis error, and returns an editable interpretation without building', async () => {
  const source = (await build({ stdin: { contents: `import {h,render} from 'preact'; import {VideoInput} from './app/studio/video.tsx'; render(h(VideoInput,{note:'This is my key',disabled:false,onBusy:v=>window.busy=v,onResult:(id,r)=>window.result={id,...r}}),document.body);`, resolveDir: process.cwd() }, bundle: true, format: 'iife', write: false, jsx: 'automatic', jsxImportSource: 'preact' })).outputFiles[0].text;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage(); let received = 0, attempts = 0; const calls: string[] = [];
    await page.route('http://video.test/**', async route => {
      if (!route.request().url().includes('/api/')) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' });
      const name = route.request().url().split('/').at(-1)!; calls.push(name); const input = route.request().postDataJSON();
      if (name === 'video_upload') { if (input.data) received += Buffer.from(input.data, 'base64').length; return route.fulfill({ json: { result: { id: 'a'.repeat(32), received } } }); }
      if (name === 'video_inspect') return route.fulfill({ json: { result: { duration: 65, audio: true, parts: 3 } } });
      if (name === 'video_read') { if (attempts++ === 0) return route.fulfill({ status: 502, json: { error: 'Speech service unavailable' } }); return route.fulfill({ json: { result: {} } }); }
      if (name === 'video_result') return route.fulfill({ json: { result: { idea: 'The key opens a blue house.', photos: [], totalFrames: 0, observations: [] } } });
      throw new Error(`Unexpected action ${name}`);
    });
    await page.goto('http://video.test'); await page.addScriptTag({ content: source });
    await page.locator('input[type=file]').setInputFiles({ name: 'brief.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(3 * 1024 * 1024, 1) });
    await page.getByRole('alert').waitFor();
    expect(await page.getByRole('alert').innerText()).toContain('Speech service unavailable');
    expect(received).toBe(3 * 1024 * 1024);
    await page.getByRole('button', { name: 'Resume video' }).click();
    await page.waitForFunction(() => !!(window as any).result);
    expect(await page.evaluate(() => (window as any).result.idea)).toBe('The key opens a blue house.');
    expect(received).toBe(3 * 1024 * 1024);
    expect(calls).not.toContain('world_new');
    expect(await page.locator('video').count()).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem('diorama-video-upload'))).toBe(null);
  } finally { await browser.close(); }
}, 30000);
