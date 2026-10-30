// A character up close, for the film's "how it's made": the Cast card in Studio, the 3D model turning as it walks
// and talks, then the walk the game draws. Free: it only plays files the build made.
//   npx tsx app/demo/cast-take.ts <slug> <who> [--out app/demo/footage/cast]
// Writes take.mp4 (1920x1080) and take.json (seconds into the video of each beat).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { takeOption } from '../src/registry.ts';

const args = process.argv.slice(2);
const out = path.resolve(takeOption(args, 'out', 'app/demo/footage/cast'));
const [slug, who] = args;
if (!slug || !who) throw new Error('usage: cast-take.ts <slug> <who> [--out dir]');

const { startStudio } = await import('../src/studio/server.ts');
const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright');
const studio = await startStudio({ root: 'worlds' });
fs.mkdirSync(path.join(out, 'raw'), { recursive: true });
const browser = await chromium.launch();
// Laid out as 1536x864 and scaled up to 1920x1080 at the end, as the other takes.
const context = await browser.newContext({ viewport: { width: 1536, height: 864 }, recordVideo: { dir: path.join(out, 'raw'), size: { width: 1536, height: 864 } } });
const page = await context.newPage();
const started = Date.now();
const beats: Record<string, number> = {};
const beat = (name: string) => {
  beats[name] = Math.round((Date.now() - started) / 100) / 10;
  console.log(`${beats[name].toFixed(1).padStart(7)} s  ${name}`);
};
const nice = (key: string) => key.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
const tab = (name: string) => page.locator(`#cast-${who} .tabs button`, { hasText: name }).click();
const mode = (name: string) => page.locator(`#cast-${who} .moves button`, { hasText: name }).first().click();
try {
  await page.goto(`${studio.url}#${studio.token}`);
  await page.waitForTimeout(1000);
  await page.goto(`${studio.url}w/${encodeURIComponent(slug)}`);
  await page.locator('.wcard[data-opening=cast]').first().click();
  await page.waitForTimeout(2500);
  beat('cast');
  // The lineup on the stage; the character's own card (with the preview) opens from Details.
  await page.locator('.lineup .who', { hasText: nice(who) }).first().click();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Details' }).first().click();
  await page.locator(`#cast-${who}`).waitFor();
  await page.locator(`#cast-${who}`).scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500);
  beat('details');
  // Details opens the focused character with its preview already playing.
  const see = page.locator(`#cast-${who} button[aria-label="See it move"]`);
  if (await see.isVisible()) await see.click();
  await page.waitForTimeout(3000);
  beat('sprites');
  await tab('3D model').catch(() => {});
  await page.locator(`#cast-${who} .turntable canvas`).waitFor({ timeout: 60_000 });
  await page.locator(`#cast-${who} .turntable`).scrollIntoViewIfNeeded();
  const spin = page.locator(`#cast-${who} .moves input[type=checkbox]`);
  if (!(await spin.isChecked())) await spin.check();
  await page.waitForTimeout(1000);
  beat('3D walk');
  await page.waitForTimeout(7000);
  await mode('talk');
  beat('3D talk');
  await page.waitForTimeout(5000);
  await tab('2D walk').catch(() => {});
  beat('2D walk');
  await page.waitForTimeout(4000);
  beat('end');
} finally {
  const recorded = page.video();
  await context.close();
  await browser.close();
  await studio.close();
  const raw = await recorded?.path();
  if (raw) {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-vf', 'scale=1920:1080:flags=lanczos', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-crf', '20', '-r', '30', path.join(out, 'take.mp4')]);
    fs.rmSync(path.join(out, 'raw'), { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(out, 'take.json'), `${JSON.stringify({ slug, who, beats }, null, 2)}\n`);
  console.log(path.join(out, 'take.mp4'));
}
