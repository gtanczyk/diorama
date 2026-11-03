// Smooth real-time recording of the play page: Chrome itself (new headless, on the GPU, ~60 fps; Playwright's bundled
// headless shell renders on SwiftShader and looks choppy), every painted frame from a CDP screencast, a drawn cursor
// that glides like a hand, and the frames laid out to a constant 60 fps by their timestamps.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Browser, CDPSession, Page } from 'playwright';
import { chromium } from '../commands/explore.ts';

/** A white arrow drawn in the page, following the mouse; it dips on press. */
const CURSOR = `(() => {
  const c = document.createElement('div');
  c.id = '__cursor';
  c.innerHTML = '<svg width="34" height="40" viewBox="0 0 17 20"><path d="M1 1 L1 16 L5 12.5 L8 19 L10.5 18 L7.6 11.6 L13 11.6 Z" fill="white" stroke="black" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  Object.assign(c.style, { position: 'fixed', left: '0', top: '0', zIndex: 2147483647, pointerEvents: 'none', transform: 'translate(-100px,-100px)', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.35))', transition: 'scale .08s' });
  const put = () => document.documentElement.appendChild(c);
  document.readyState === 'loading' ? addEventListener('DOMContentLoaded', put) : put();
  addEventListener('mousemove', (e) => { c.style.transform = 'translate(' + (e.clientX - 3) + 'px,' + (e.clientY - 2) + 'px)'; }, true);
  addEventListener('mousedown', () => { c.style.scale = '0.85'; }, true);
  addEventListener('mouseup', () => { c.style.scale = '1'; }, true);
})()`;

const ease = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);

export type Recorder = {
  page: Page;
  /** Wall-clock seconds (Date.now() / 1000) of each click. */
  clicks: number[];
  start(): Promise<void>;
  glide(x: number, y: number, ms?: number): Promise<void>;
  click(x: number, y: number, opts?: { ms?: number; dwell?: number; button?: 'left' | 'right' }): Promise<number>;
  /** The cursor dips as in a click, without a click reaching the page. */
  tap(x: number, y: number, opts?: { ms?: number; dwell?: number }): Promise<number>;
  /** Writes `mp4` at a constant `fps`; returns the wall-clock second of its first frame and its length. */
  stop(mp4: string, fps?: number): Promise<{ first: number; seconds: number; frames: number }>;
  close(): Promise<void>;
};

/** Opens a page of width x height (page pixels) recording into `work` (frames are kept there until close). */
export async function openRecorder(width: number, height: number, work: string, log: (s: string) => void = console.log): Promise<Recorder> {
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(path.join(work, 'frames'), { recursive: true });
  const pw = (await chromium()) as unknown as typeof import('playwright').chromium;
  const args = ['--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'];
  let browser: Browser;
  try {
    browser = await pw.launch({ channel: 'chrome', args });
  } catch (error) {
    log(`Chrome is not installed (${(error as Error).message.split('\n')[0]}); recording with Playwright's own browser, which may be choppy`);
    browser = await pw.launch({ args });
  }
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  await ctx.addInitScript(CURSOR);
  const page = await ctx.newPage();
  const cdp: CDPSession = await ctx.newCDPSession(page);
  const frames: Array<{ file: string; t: number }> = [];
  let recording = false;
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    if (!recording || metadata.timestamp === undefined) return;
    const file = path.join(work, 'frames', `${String(frames.length).padStart(6, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ file, t: metadata.timestamp });
  });
  let mouse = { x: width / 2, y: height / 2 };
  const glide = async (x: number, y: number, ms = 550) => {
    const from = { ...mouse }, n = Math.max(8, Math.round(ms / 16));
    for (let i = 1; i <= n; i++) {
      const u = ease(i / n);
      await page.mouse.move(from.x + (x - from.x) * u, from.y + (y - from.y) * u);
      await page.waitForTimeout(ms / n);
    }
    mouse = { x, y };
  };
  const rec: Recorder = {
    page,
    clicks: [],
    async start() {
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
      recording = true;
    },
    glide,
    async click(x, y, opts = {}) {
      await glide(x, y, opts.ms);
      await page.waitForTimeout(opts.dwell ?? 300);
      const at = Date.now() / 1000;
      rec.clicks.push(at);
      await page.mouse.down({ button: opts.button ?? 'left' });
      await page.waitForTimeout(70);
      await page.mouse.up({ button: opts.button ?? 'left' });
      return at;
    },
    async tap(x, y, opts = {}) {
      await glide(x, y, opts.ms);
      await page.waitForTimeout(opts.dwell ?? 300);
      const at = Date.now() / 1000;
      rec.clicks.push(at);
      await page.evaluate(`document.getElementById('__cursor') && (document.getElementById('__cursor').style.scale = '0.85')`);
      await page.waitForTimeout(90);
      await page.evaluate(`document.getElementById('__cursor') && (document.getElementById('__cursor').style.scale = '1')`);
      return at;
    },
    async stop(mp4, fps = 60) {
      recording = false;
      await cdp.send('Page.stopScreencast').catch(() => {});
      const end = Date.now() / 1000;
      if (!frames.length) throw new Error('the screencast recorded no frames');
      // Each frame holds until the next one was painted (the screencast may deliver them slightly out of order).
      frames.sort((a, b) => a.t - b.t);
      const lines = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, (frames[i + 1]?.t ?? end) - f.t).toFixed(4)}\n`);
      const list = path.join(work, 'frames.txt');
      fs.writeFileSync(list, lines.join('') + `file '${frames.at(-1)!.file}'\n`);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-vf', `scale=${width}:${height}:flags=lanczos,fps=${fps},format=yuv420p`,
        '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', mp4]);
      return { first: frames[0].t, seconds: end - frames[0].t, frames: frames.length };
    },
    async close() {
      await browser.close().catch(() => {});
      fs.rmSync(path.join(work, 'frames'), { recursive: true, force: true });
    },
  };
  return rec;
}
