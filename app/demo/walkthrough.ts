// The whole Studio in one take, for the film: an idea and photos on the front page, Diorama's questions answered,
// the build on the stage, the game played, a change asked with a screenshot, the game played again, then a zip
// exported and played as a plain web page. A real build with a real agent; rerunnable.
//   npx tsx app/demo/walkthrough.ts --idea "<idea>" --photo a.jpg [--photo b.jpg ...] [--video v.mp4]
//     --change "<what to ask, with the screenshot>" [--agent muse|claude|codex] [--out app/demo/footage/walkthrough]
// Writes take.mp4 (1920x1080) and take.json (seconds into the video of each beat, so the cut can speed up the waits).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { takeOption } from '../src/registry.ts';

const args = process.argv.slice(2);
const idea = takeOption(args, 'idea', '');
const change = takeOption(args, 'change', '');
const video = takeOption(args, 'video', '');
const agent = takeOption(args, 'agent', 'muse');
// --review-only: the take stops once Diorama's questions are answered, nothing is built.
const reviewOnly = args.includes('--review-only');
const out = path.resolve(takeOption(args, 'out', 'app/demo/footage/walkthrough'));
const photos: string[] = [];
for (let at = args.indexOf('--photo'); at >= 0; at = args.indexOf('--photo')) photos.push(path.resolve(args.splice(at, 2)[1]));
if (!idea || !change) throw new Error('usage: walkthrough.ts --idea "<idea>" --photo a.jpg ... --change "<what to ask>" [--video v.mp4] [--agent muse]');

process.env.DIORAMA_AGENT = agent;
const { startStudio } = await import('../src/studio/server.ts');
const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright');

const studio = await startStudio({ root: 'worlds' });
fs.mkdirSync(path.join(out, 'raw'), { recursive: true });
const browser = await chromium.launch();
// Laid out as 1536x864 and scaled up to 1920x1080 at the end, so the text reads in the film.
const context = await browser.newContext({ viewport: { width: 1536, height: 864 }, recordVideo: { dir: path.join(out, 'raw'), size: { width: 1536, height: 864 } } });
const started = Date.now();
const beats: Record<string, number> = {};
const beat = (name: string) => {
  beats[name] = Math.round((Date.now() - started) / 100) / 10;
  console.log(`${beats[name].toFixed(1).padStart(7)} s  ${name}`);
};
type Job = { by: string; state: string; world: string; label: string };
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
const jobEnd = (world: string, by?: string) => (e: { type: string; [k: string]: unknown }) => e.type === 'job.end' && (e.job as Job).world === world && (!by || (e.job as Job).by === by);

const page = await context.newPage();
/** Walks a few steps in the game on the stage. */
const walk = async (frameSelector: string, spots: number[][]) => {
  const frame = await page.locator(frameSelector).boundingBox();
  if (frame) for (const [x, y] of spots) {
    await page.mouse.click(frame.x + frame.width * x, frame.y + frame.height * y);
    await page.waitForTimeout(3000);
  }
};
let world = '';
let server: ReturnType<typeof spawn> | undefined;
try {
  await page.goto(`${studio.url}#${studio.token}`);
  await page.waitForTimeout(1500);
  beat('front page');
  const box = page.locator('textarea[aria-label="Your idea"]');
  await box.click();
  await box.pressSequentially(idea, { delay: 35 });
  beat('idea typed');
  if (photos.length) await page.locator('form.hero input[type=file][accept^="image"]').setInputFiles(photos);
  await page.waitForTimeout(1500);
  beat('photos added');
  if (video) {
    await page.locator('input.video-picker').setInputFiles(video);
    await page.getByText('Video understood', { exact: false }).waitFor({ timeout: 15 * 60_000 });
    beat('video understood');
  }
  await page.getByRole('button', { name: 'Build it' }).click();
  beat('review');
  // Diorama asks at most two questions with pictures; each first option is taken once its sketches are in.
  const buildMine = page.getByRole('button', { name: 'Build my world' });
  for (let asked = 0; asked < 3 && !(await buildMine.isVisible()); asked++) {
    const cards = page.locator('.review-current .review-cards .idea-card');
    await Promise.race([cards.first().waitFor({ timeout: 5 * 60_000 }), buildMine.waitFor({ timeout: 5 * 60_000 })]);
    if (await buildMine.isVisible()) break;
    beat(`question ${asked + 1}`);
    await page.locator('.review-current .idea-card-picture img').first().waitFor({ timeout: 90_000 }).catch(() => {});
    await page.waitForTimeout(3000);
    await cards.first().click();
    beat(`answer ${asked + 1}`);
    await page.waitForTimeout(1500);
  }
  if (reviewOnly) {
    await page.waitForTimeout(3000);
    beat('end');
    throw new Error('review only: stopped before the build');
  }
  await buildMine.click();
  await page.waitForURL(/\/w\//, { timeout: 5 * 60_000 });
  world = decodeURIComponent(new URL(page.url()).pathname.split('/')[2]);
  beat('build started');
  await next(jobEnd(world), 90, 'end of the build');
  await page.waitForTimeout(4000);
  beat('built');

  await page.locator('.stage-top button', { hasText: 'Play' }).first().click();
  await page.locator('.stage-body.play iframe').waitFor();
  await page.waitForTimeout(5000);
  beat('playing');
  await walk('.stage-body.play iframe', [[0.3, 0.85], [0.7, 0.8], [0.55, 0.88]]);
  // The idea for a change comes from the game: its picture goes with the message.
  const shot = path.join(out, 'screenshot.png');
  await page.locator('.stage-body.play iframe').screenshot({ path: shot });
  await page.locator('section.convo input[type=file][accept^="image"]').setInputFiles(shot);
  await page.waitForTimeout(2000);
  beat('screenshot added');
  const changed = next(jobEnd(world, 'agent'), 25, 'end of the agent job');
  const ask = page.locator('section.convo textarea');
  await ask.click();
  await ask.pressSequentially(change, { delay: 40 });
  await ask.press('Enter');
  beat('change asked');
  await changed;
  await page.locator('section.convo .live.on', { hasText: 'ready' }).waitFor({ timeout: 10 * 60_000 });
  beat('changed');
  await page.locator('.stage-top button', { hasText: 'Play' }).first().click().catch(() => {});
  await page.locator('.stage-body.play iframe').waitFor();
  await page.waitForTimeout(5000);
  beat('playing again');
  await walk('.stage-body.play iframe', [[0.3, 0.85], [0.6, 0.8]]);

  await page.locator('.share > button', { hasText: 'Share' }).click();
  await page.waitForTimeout(1200);
  beat('share');
  const exported = next(jobEnd(world), 10, 'end of the export');
  await page.getByRole('button', { name: 'Make a zip' }).click();
  await exported;
  await page.waitForTimeout(2500);
  beat('exported');
  // The export is a plain web page: served as files, it plays in any browser, no Studio behind it.
  server = spawn('python3', ['-m', 'http.server', '4199', '--bind', '127.0.0.1'], { cwd: path.resolve('exports', world), stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  await page.goto('http://127.0.0.1:4199/');
  await page.waitForTimeout(6000);
  beat('in the browser');
  await walk('body', [[0.4, 0.85], [0.65, 0.8]]);
  beat('end');
} finally {
  server?.kill();
  const recorded = page.video();
  await context.close();
  await browser.close();
  await studio.close();
  const raw = await recorded?.path();
  if (raw) {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-vf', 'scale=1920:1080:flags=lanczos', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-crf', '20', '-r', '30', path.join(out, 'take.mp4')]);
    fs.rmSync(path.join(out, 'raw'), { recursive: true, force: true });
  }
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(out, 'take.json'), `${JSON.stringify({ world, idea, photos: photos.map((p) => path.basename(p)), video: video && path.basename(video), change, agent, commit, beats }, null, 2)}\n`);
  console.log(`${path.join(out, 'take.mp4')}\n${path.join(out, 'take.json')}`);
}
