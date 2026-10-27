// A scripted Studio take for the film: the game is open on a place, the agent is asked to fix it, its repaint shows
// in the game, Undo brings the old painting back, Redo the new one, then the hero walks. Rerunnable; the agent is real.
//   npx tsx demo/studio-take.ts <slug> --place <place> --prompt "<what to ask>" [--agent muse|claude|codex] [--out demo/footage/studio]
// Writes take.mp4 (1920x1080) and take.json (seconds into the video of each beat, so the cut can speed up the waits).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { takeOption } from '../src/registry.ts';

const args = process.argv.slice(2);
const place = takeOption(args, 'place', '');
const prompt = takeOption(args, 'prompt', '');
const agent = takeOption(args, 'agent', 'muse');
const out = path.resolve(takeOption(args, 'out', 'demo/footage/studio'));
const [slug] = args.filter((a) => !a.startsWith('--'));
if (!slug || !place || !prompt) throw new Error('usage: npx tsx demo/studio-take.ts <slug> --place <place> --prompt "<what to ask>" [--agent muse] [--out dir]');

process.env.DIORAMA_AGENT = agent;
const { startStudio } = await import('../src/studio/server.ts');
const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright');

const studio = await startStudio({ root: 'worlds' });
fs.mkdirSync(path.join(out, 'raw'), { recursive: true });
const browser = await chromium.launch();
// Recorded at 1920x1080 and zoomed 1.25x (laid out as 1536x864), so the text reads in the film.
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: path.join(out, 'raw'), size: { width: 1920, height: 1080 } } });
await context.addInitScript(() => document.addEventListener('DOMContentLoaded', () => void (document.documentElement.style.zoom = '1.25')));
const started = Date.now();
const beats: Record<string, number> = {};
const beat = (name: string) => {
  beats[name] = Math.round((Date.now() - started) / 100) / 10;
  console.log(`${beats[name].toFixed(1).padStart(6)} s  ${name}`);
};
/** The next Studio event that matches, or an error after `minutes`. */
const next = (match: (e: { type: string; [k: string]: unknown }) => boolean, minutes: number, what: string) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => (stop(), reject(new Error(`no ${what} in ${minutes} min`))), minutes * 60_000);
  const stop = studio.events.subscribe((e) => {
    if (!match(e)) return;
    clearTimeout(timer);
    stop();
    resolve();
  });
});

const page = await context.newPage();
const idle = () => page.locator('section.agent .live.on', { hasText: 'ready' }).waitFor({ timeout: 10 * 60_000 });
const ask = async (text: string) => {
  const box = page.locator('section.agent textarea');
  await box.click();
  await box.pressSequentially(text, { delay: 45 });
  await box.press('Enter');
};
try {
  await page.goto(`${studio.url}#${studio.token}`);
  await page.waitForTimeout(800);
  await page.goto(`${studio.url}w/${slug}`);
  // The game open on the place: the repaint, Undo and Redo show in the painting itself.
  await page.locator('.places .card', { hasText: place }).first().click();
  await page.getByRole('button', { name: `Play from ${place}` }).click();
  await page.locator('.play iframe').waitFor();
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await page.waitForTimeout(4000);
  beat('play shown');

  const repainted = next((e) => e.type === 'job.end' && (e.job as { by: string; state: string }).by === 'agent' && (e.job as { state: string }).state === 'done', 15, 'finished agent job');
  await ask(prompt);
  beat('prompt sent');
  await repainted;
  await idle();
  // The agent reloads the game itself (play_reload); if it did not, the person's Reload button does.
  const reload = page.getByRole('button', { name: 'Reload the game' });
  if (await reload.isVisible()) await reload.click();
  await page.waitForTimeout(4000);
  beat('repaint visible');
  await page.waitForTimeout(2000);

  // Undo and Redo reload the game on their own.
  await page.getByRole('button', { name: 'Undo last job' }).click();
  beat('undo');
  await page.waitForTimeout(5000);
  await page.getByRole('button', { name: 'Redo' }).click();
  beat('redo');
  await page.waitForTimeout(5000);

  // A few steps around the place, so the cut can flip straight into the game.
  const frame = await page.locator('.play iframe').boundingBox();
  if (frame) for (const [x, y] of [[0.3, 0.85], [0.7, 0.8], [0.5, 0.9]]) {
    await page.mouse.click(frame.x + frame.width * x, frame.y + frame.height * y);
    await page.waitForTimeout(3000);
  }
  beat('end');
} finally {
  const video = page.video();
  await context.close();
  await browser.close();
  await studio.close();
  const raw = await video?.path();
  if (raw) {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-r', '30', path.join(out, 'take.mp4')]);
    fs.rmSync(path.join(out, 'raw'), { recursive: true, force: true });
  }
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(out, 'take.json'), `${JSON.stringify({ world: slug, place, agent, prompt, commit, beats }, null, 2)}\n`);
  console.log(`${path.join(out, 'take.mp4')}\n${path.join(out, 'take.json')}`);
}
