import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { expect, test } from 'vitest';
import { serveWorld } from '../src/commands/play.ts';
import { Story } from '../src/story/schema.ts';
import { WorldFiles } from '../src/world/files.ts';
import { scene } from './fixtures/scene.ts';

/** A local tone, so playback completion is tested without a paid voice service. */
function wave(seconds: number) {
  const rate = 8000, samples = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 330 / rate) * 1000), 44 + i * 2);
  return b;
}

test('voiced dialogue follows actual audio completion even with a slow game clock; silent text keeps reading time', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dialogue-voice-timing-'));
  const { put } = await scene(root, true);
  put('story.json', Story.parse({ intro: 'Start.', items: [], interactions: [], endings: [{ key: 'end', title: 'End', text: 'End.' }], dialogues: [{
    place: 'room', npc: 'guard', start: 'hello', lines: [
      { key: 'hello', says: 'Hello.', choices: [{ text: 'Yes.', next: 'reply' }] },
      { key: 'reply', says: 'Next reply.', choices: [] },
    ],
  }] }));
  const server = await serveWorld(new WorldFiles('w', root), 0);
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage();
    await page.route('**/world-data.json', async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.sound = { files: {}, places: {}, shots: {}, lines: Object.fromEntries(['Hello.', 'Yes.', 'Next reply.'].map((text) => [text, { file: 'voice.wav', seconds: 9 }])) };
      await route.fulfill({ response, json: data });
    });
    await page.route('**/files/voice.wav', (route) => route.fulfill({ contentType: 'audio/wav', body: wave(0.7) }));
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/?place=room`);
    await page.waitForFunction('window.diorama?.place && window.diorama.dark === 0');
    await page.evaluate(async () => {
      const w = window as any, g = w.diorama;
      await g.sound.ctx.resume();
      w.events = [];
      g.on((event: string, detail: object) => w.events.push({ event, ...detail, at: performance.now() }));
      const ended = g.voiceEnded.bind(g);
      g.voiceEnded = (speech: any) => { w.events.push({ event: 'audio-ended', text: speech?.text, at: performance.now() }); ended(speech); };
      const update = g.update.bind(g);
      g.update = (dt: number) => update(dt * 0.01);
      void g.act({ kind: 'talk', npc: 'guard' });
    });
    await page.locator('#talk .answer').click();
    await page.waitForFunction('window.diorama.speech?.text === "Yes." && window.diorama.speech.audioUntil === Infinity');
    // Even an expired simulation deadline must not cut a playing voice short.
    expect(await page.evaluate(() => {
      const g = (window as any).diorama;
      g.time += 100; g.update(0); return g.speech?.text;
    })).toBe('Yes.');
    await page.waitForFunction('window.diorama.speech?.text === "Next reply."', undefined, { timeout: 3000 });
    const gap = await page.evaluate(() => {
      const e = (window as any).events;
      return e.find((v: any) => v.event === 'say' && v.text === 'Next reply.').at - e.find((v: any) => v.event === 'audio-ended' && v.text === 'Yes.').at;
    });
    expect(gap).toBeGreaterThanOrEqual(240);
    expect(gap).toBeLessThan(1000);
    // Muted/missing audio falls back to readable text and does not wait forever.
    const fallback = await page.evaluate(async () => {
      const g = (window as any).diorama;
      g.sound.muted = true;
      void g.act({ kind: 'leave' });
      await new Promise((r) => setTimeout(r, 100));
      void g.say('Yes.');
      await new Promise((r) => setTimeout(r, 100));
      const mutedUsesReadingTime = g.speech.audioUntil === undefined;
      void g.say('No recording.');
      const speech = g.speech;
      g.update(1);
      return { mutedUsesReadingTime, audioUntil: speech.audioUntil, readingTime: speech.until - speech.from, remains: g.speech === speech };
    });
    expect(fallback.audioUntil).toBeUndefined();
    expect(fallback.mutedUsesReadingTime).toBe(true);
    expect(fallback.readingTime).toBeGreaterThan(2);
    expect(fallback.remains).toBe(true);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
