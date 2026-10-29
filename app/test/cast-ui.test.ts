import { build } from 'esbuild';
import { chromium } from 'playwright';
import { expect, test } from 'vitest';

test('cast shows queued, running and failed 3D attempts without inviting duplicate requests', async () => {
  const source = (await build({
    stdin: { contents: `import { h, render } from 'preact'; import { CastView } from './app/studio/cast.tsx';
      window.showCast = version => render(h(CastView, {slug:'w', version, onError:console.error}), document.body); window.showCast(0);`, resolveDir: process.cwd() },
    bundle: true, format: 'iife', write: false, jsx: 'automatic', jsxImportSource: 'preact',
  })).outputFiles[0].text;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let state = 'queued';
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const reason = 'TRELLIS upload: HTTP 500 (3 attempt(s))';
    const character = () => ({
      key: 'hedgehog', role: 'npc', place: 'garden', looks: 'a small hedgehog', looksNow: 'a small hedgehog', fix: null,
      figure: { file: 'cast/hedgehog.png', v: 1 }, painting: null, rig: false, model: false, sprites: false,
      modelIssue: state === 'failed' ? reason : null,
      modelAttempt: state === 'failed' ? { state: 'failed', reason, at: 'now' } : null,
      modelJob: state === 'failed' ? null : { id: 'job', state }, body: { height: .4, upright: false },
      stamps: { rig: null, model: null, sprites: null }, voice: null, lines: 0, flagged: 0, sample: null,
    });
    await page.route('http://cast.test/**', (r) => {
      const url = new URL(r.request().url());
      if (url.pathname.startsWith('/api/actions/')) return r.fulfill({ json: { result: url.pathname.endsWith('cast_status') ? [character()] : [] } });
      return r.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' });
    });
    await page.goto('http://cast.test');
    await page.addScriptTag({ content: source });
    for (const [i, s, label] of [[0, 'queued', '3D queued…'], [1, 'running', 'Building 3D…'], [2, 'failed', 'Retry 3D']] as const) {
      state = s;
      if (i) await page.evaluate((i) => (window as unknown as { showCast: (n: number) => void }).showCast(i), i);
      const button = page.getByRole('button', { name: label, exact: true });
      await button.waitFor();
      expect(await button.isDisabled()).toBe(s !== 'failed');
    }
    await page.getByText(`Using 2D: ${reason}`, { exact: true }).waitFor();
    expect(errors).toEqual([]);
  } finally { await browser.close(); }
}, 30_000);
