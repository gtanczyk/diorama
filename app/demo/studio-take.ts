// Scripted Studio takes for the film, recorded from the real Studio with a real agent and real builds. Rerunnable.
//   Make a world: the idea is typed on the atelier's front page, the photos go with it, Build it, the build runs on
//   the stage until the game is ready, then it is played.
//     npx tsx app/demo/studio-take.ts --new "<idea>" [--photo room.jpg --photo me.jpg ...] [--out app/demo/footage/studio-new]
//   Change a world: a thing is clicked on the stage, the agent is asked about it, its change shows, Undo takes it
//   back, Redo brings it again, then the game is played.
//     npx tsx app/demo/studio-take.ts <slug> --place <place> --thing <thing> --prompt "<what to ask>" [--screenshot] [--agent muse|claude|codex] [--out app/demo/footage/studio]
// Writes take.mp4 (1920x1080) and take.json (seconds into the video of each beat, so the cut can speed up the waits).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { takeOption } from '../src/registry.ts';

const args = process.argv.slice(2);
const idea = takeOption(args, 'new', '');
const photos: string[] = [];
for (let at = args.indexOf('--photo'); at >= 0; at = args.indexOf('--photo')) photos.push(path.resolve(args.splice(at, 2)[1]));
const place = takeOption(args, 'place', '');
const thing = takeOption(args, 'thing', '');
const prompt = takeOption(args, 'prompt', '');
const agent = takeOption(args, 'agent', 'muse');
// --screenshot: a screenshot of the stage goes with the message, as a person pastes one.
const screenshot = args.includes('--screenshot');
const out = path.resolve(takeOption(args, 'out', idea ? 'app/demo/footage/studio-new' : 'app/demo/footage/studio'));
const [slug] = args.filter((a) => !a.startsWith('--'));
if (!idea && (!slug || !place || !thing || !prompt)) {
  throw new Error('usage: studio-take.ts --new "<idea>" [--photo f.jpg]... | studio-take.ts <slug> --place <place> --thing <thing> --prompt "<what to ask>" [--agent muse]');
}

process.env.DIORAMA_AGENT = agent;
const { startStudio } = await import('../src/studio/server.ts');
const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright');

const studio = await startStudio({ root: 'worlds' });
fs.mkdirSync(path.join(out, 'raw'), { recursive: true });
const browser = await chromium.launch();
// Laid out as 1536x864 and scaled up to 1920x1080 at the end, so the text reads in the film. (CSS zoom would cut
// the Studio's full-height layout off at the bottom; the recording ignores deviceScaleFactor.)
const context = await browser.newContext({ viewport: { width: 1536, height: 864 }, recordVideo: { dir: path.join(out, 'raw'), size: { width: 1536, height: 864 } } });
const started = Date.now();
const beats: Record<string, number> = {};
const beat = (name: string) => {
  beats[name] = Math.round((Date.now() - started) / 100) / 10;
  console.log(`${beats[name].toFixed(1).padStart(7)} s  ${name}`);
};
type Job = { by: string; state: string; world: string };
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
const nice = (key: string) => key.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

const page = await context.newPage();
const typeSlowly = async (box: ReturnType<typeof page.locator>, text: string) => {
  await box.click();
  await box.pressSequentially(text, { delay: 40 });
};
/** A few steps in the game on the stage, so the cut can end inside it. */
const play = async () => {
  await page.locator('.stage-top button', { hasText: '▶ Play' }).click();
  await page.locator('.stage-body.play iframe').waitFor();
  await page.waitForTimeout(4000);
  beat('playing');
  const frame = await page.locator('.stage-body.play iframe').boundingBox();
  if (frame) for (const [x, y] of [[0.3, 0.85], [0.7, 0.8], [0.5, 0.9]]) {
    await page.mouse.click(frame.x + frame.width * x, frame.y + frame.height * y);
    await page.waitForTimeout(3000);
  }
};
let world = slug;
try {
  await page.goto(`${studio.url}#${studio.token}`);
  await page.waitForTimeout(1500);
  if (idea) {
    beat('front page');
    await typeSlowly(page.locator('textarea[aria-label="Your idea"]'), idea);
    if (photos.length) await page.locator('form.hero input[type=file]').setInputFiles(photos);
    await page.waitForTimeout(1500);
    beat('idea typed');
    await page.getByRole('button', { name: 'Build it' }).click();
    await page.waitForURL(/\/w\//, { timeout: 5 * 60_000 });
    world = decodeURIComponent(new URL(page.url()).pathname.split('/')[2]);
    beat('build started');
    await next((e) => e.type === 'job.end' && (e.job as Job).world === world, 90, 'end of the build');
    await page.waitForTimeout(4000);
    beat('built');
  } else {
    await page.goto(`${studio.url}w/${slug}`);
    await page.locator('.wcard .thumb').first().waitFor();
    // The place on the stage, then the thing clicked: it goes into the message as "this".
    await page.locator(`.wcard .thumb[title^="${nice(place)}:"]`).first().click();
    await page.waitForTimeout(2500);
    beat('place shown');
    await page.locator(`.stage-body .spot[aria-label="Talk about the ${nice(thing).toLowerCase()}"]`).click();
    await page.waitForTimeout(1500);
    beat('thing picked');
    // However the agent's job ends (a verify flag fails it too), the take goes on once the agent is ready again.
    const changed = next((e) => e.type === 'job.end' && (e.job as Job).by === 'agent', 20, 'end of the agent job');
    if (screenshot) {
      const shot = path.join(out, 'screenshot.png');
      await page.locator('.stage-body').screenshot({ path: shot });
      await page.locator('section.convo input[type=file][accept^="image"]').setInputFiles(shot);
      await page.waitForTimeout(1500);
      beat('screenshot added');
    }
    const box = page.locator('section.convo textarea');
    await typeSlowly(box, prompt);
    await box.press('Enter');
    beat('prompt sent');
    await changed;
    await page.locator('section.convo .live.on', { hasText: 'ready' }).waitFor({ timeout: 10 * 60_000 });
    // The change on the stage: the Changed card shows the place the agent touched.
    await page.locator('.wcard', { hasText: 'Changed' }).last().locator('.thumb').first().click().catch(() => {});
    await page.waitForTimeout(4000);
    beat('change shown');
    await page.locator('.wcard button', { hasText: '↶ Undo' }).last().click();
    await page.waitForTimeout(5000);
    beat('undo');
    await page.locator('.world-note button.link', { hasText: 'Redo' }).click();
    await page.waitForTimeout(5000);
    beat('redo');
  }
  await play();
  beat('end');
} finally {
  const video = page.video();
  await context.close();
  await browser.close();
  await studio.close();
  const raw = await video?.path();
  if (raw) {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-vf', 'scale=1920:1080:flags=lanczos', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-r', '30', path.join(out, 'take.mp4')]);
    fs.rmSync(path.join(out, 'raw'), { recursive: true, force: true });
  }
  const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(out, 'take.json'), `${JSON.stringify({ world, idea: idea || undefined, photos: photos.map((p) => path.basename(p)), place, thing, agent, prompt, commit, beats }, null, 2)}\n`);
  console.log(`${path.join(out, 'take.mp4')}\n${path.join(out, 'take.json')}`);
}
