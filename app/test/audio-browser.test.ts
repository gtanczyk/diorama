import { build } from 'esbuild';
import { chromium } from 'playwright';
import { expect, test } from 'vitest';

test('a slow old voice fetch cannot start over a newer line, and the same text uses its speaker', async () => {
  const script = (await build({ entryPoints: ['app/web/audio.ts'], bundle: true, format: 'iife', globalName: 'AudioGame', write: false })).outputFiles[0].text;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('http://audio.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><body><button>Start</button></body>' }));
    await page.goto('http://audio.test');
    await page.addScriptTag({ content: script });
    const result = await page.evaluate(async () => {
      const w = window as unknown as { AudioGame: { Mixer: new (g: unknown, url: (f: string) => string) => { ctx: AudioContext; log: Array<{ id: string }> } } };
      let event: (e: string, d: object) => void = () => {};
      const game = { data: { world: { hero: { key: 'hero' } }, sound: { files: {}, places: {}, shots: {}, bySpeaker: {
        hero: { 'Cześć!': { file: 'slow-hero', seconds: 1, speaker: 'hero' }, 'Bye.': { file: 'cancelled', seconds: 1, speaker: 'hero' } },
        owl: { 'Cześć!': { file: 'fast-owl', seconds: 1, speaker: 'owl' } },
      } } }, speech: {}, on: (f: typeof event) => { event = f; } };
      const mixer = new w.AudioGame.Mixer(game, (f) => f);
      const requests: string[] = [];
      let release!: () => void;
      const delayed = new Promise<void>((resolve) => { release = resolve; });
      window.fetch = async (url) => { requests.push(String(url)); if (url === 'slow-hero') await delayed; return new Response(new ArrayBuffer(8)); };
      mixer.ctx.decodeAudioData = async () => mixer.ctx.createBuffer(1, 44100, 44100);
      event('say', { text: 'Cześć!', who: 'hero' });
      event('say', { text: 'Cześć!', who: 'owl' });
      await new Promise((resolve) => setTimeout(resolve, 30));
      const before = mixer.log.length;
      release();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const after = mixer.log.length;
      // A cancelled, still-loading line must not start after the player picks another action.
      let releaseCancelled!: () => void;
      const cancelled = new Promise<void>((resolve) => { releaseCancelled = resolve; });
      window.fetch = async () => { await cancelled; return new Response(new ArrayBuffer(8)); };
      event('say', { text: 'Bye.', who: 'hero' });
      event('silent', {});
      releaseCancelled();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const afterCancel = mixer.log.length;
      await mixer.ctx.close();
      return { before, after, afterCancel, requests };
    });
    expect(result.requests).toEqual(['slow-hero', 'fast-owl']);
    expect(result.before).toBe(1);
    expect(result.after).toBe(1);
    expect(result.afterCancel).toBe(1);
  } finally { await browser.close(); }
}, 30_000);
