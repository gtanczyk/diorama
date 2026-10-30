// Smooth game footage on any machine: the page's clock is stepped by hand (capture mode's fixed 1/60 s per
// frame, requestAnimationFrame held by us), a screenshot per film frame, then ffmpeg joins them at 30 fps. A slow
// container records the same smooth clip as a fast laptop, only slower.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';

export const FPS = 30;
/** Game frames per film frame: the page steps 1/60 s each. */
const STEPS = 60 / FPS;

/** Before the page loads: requestAnimationFrame only queues, window.__step(n) runs n queued frames. */
export const HOLD_FRAMES = `(() => {
  let queue = [];
  let now = 0;
  window.requestAnimationFrame = (cb) => (queue.push(cb), queue.length);
  window.__step = (n) => {
    for (let i = 0; i < n; i++) {
      const run = queue;
      queue = [];
      now += 1000 / 60;
      for (const cb of run) cb(now);
    }
  };
})();`;

/**
 * Records `seconds` of the page at FPS into `mp4`. `at` lists things to do at given seconds (a click to walk).
 * The page must have been opened with HOLD_FRAMES as an init script and with ?capture=1 for the fixed step.
 */
export async function smoothTake(page: Page, seconds: number, mp4: string, at: Array<[number, () => Promise<void>]> = []) {
  const dir = `${mp4}.frames`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const todo = [...at].sort((a, b) => a[0] - b[0]);
  const frames = Math.round(seconds * FPS);
  for (let f = 0; f < frames; f++) {
    while (todo.length && todo[0][0] * FPS <= f) await todo.shift()![1]();
    await page.evaluate((n) => (window as unknown as { __step: (n: number) => void }).__step(n), STEPS);
    await page.screenshot({ path: path.join(dir, `${String(f).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 92 });
  }
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(dir, '%05d.jpg'), '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-crf', '18', mp4]);
  fs.rmSync(dir, { recursive: true, force: true });
}
