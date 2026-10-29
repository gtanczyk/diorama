import { build } from 'esbuild';
import { chromium } from 'playwright';
import { expect, test } from 'vitest';
import { audioIssues, type AudioMisses } from '../src/sound/issues.ts';

const reason = 'waiting for a designed voice: Voice Design validation pending: transcribe voice-preview:saved: closed 4000 Audio processing backlog too large';
const misses: AudioMisses = { sounds: [], lines: [
  ...Array.from({ length: 47 }, (_, i) => ({ speaker: 'little-artist', text: `Line ${i}`, reason })),
  ...Array.from({ length: 5 }, (_, i) => ({ speaker: 'egg-creature', text: `Line ${i}`, reason })),
  { speaker: 'friendly-llama', text: 'Hello.', reason: 'speech rejected after 3 takes: heard 85% of the line' },
] };

test('legacy per-line failures collapse to root-cause groups without labelling outages bad audio', () => {
  expect(audioIssues(misses).map(({ kind, speaker, count }) => ({ kind, speaker, count }))).toEqual([
    { kind: 'validation', speaker: 'little-artist', count: 47 },
    { kind: 'validation', speaker: 'egg-creature', count: 5 },
    { kind: 'rejected', speaker: 'friendly-llama', count: 1 },
  ]);
  expect(audioIssues({ sounds: [{ id: 'wind', reason: 'HTTP 503' }], lines: [{ speaker: 'owl', text: 'Hi', reason: 'waiting for a designed voice: Voice Design failed: no free slot' }] }).map((g) => g.kind)).toEqual(['design', 'unavailable']);
});

test('Studio shows 2 pending voices and 52 blocked lines, with expandable details and a working retry', async () => {
  const source = (await build({ stdin: { contents: `import { h, render } from 'preact';
    import { AudioMissing } from './app/studio/audio-missing.tsx';
    window.retries = 0;
    window.show = misses => render(h(AudioMissing, {misses, retry: () => window.retries++}), document.body);`, resolveDir: process.cwd() }, bundle: true, format: 'iife', write: false, jsx: 'automatic', jsxImportSource: 'preact' })).outputFiles[0].text;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('about:blank'); await page.addScriptTag({ content: source });
    await page.evaluate((m) => (window as unknown as { show: (m: AudioMisses) => void }).show(m), misses);
    const text = await page.locator('body').innerText();
    expect(text).toContain('2 voices, blocking 52 lines');
    expect(text).toContain('1 other spoken line');
    expect(text).not.toContain('Sounds bad, left out');
    expect(await page.locator('[title]').count()).toBe(0);
    await page.getByText('Audio details · 3 groups', { exact: true }).click();
    expect(await page.locator('li').count()).toBe(3);
    expect(await page.locator('li').first().innerText()).toContain('47 lines');
    await page.getByRole('button', { name: 'Retry missing audio' }).click();
    expect(await page.evaluate(() => (window as unknown as { retries: number }).retries)).toBe(1);
  } finally { await browser.close(); }
}, 30_000);
