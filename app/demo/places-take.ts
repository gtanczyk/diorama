// The game itself for the film: every place of the given worlds, the hero walking a few steps with the tracking
// camera and parallax on, one clip per place. Free: it only plays what the builds made.
//   npx tsx app/demo/places-take.ts <slug> [<slug>...] [--seconds 9] [--out app/demo/footage/places]
// Writes <slug>--<place>.mp4 (1440x1080, the game's 4:3) per place.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { serveWorld } from '../src/commands/play.ts';
import { takeOption } from '../src/registry.ts';
import { WorldFiles } from '../src/world/files.ts';

const args = process.argv.slice(2);
const out = path.resolve(takeOption(args, 'out', 'app/demo/footage/places'));
const seconds = Number(takeOption(args, 'seconds', '9'));
const slugs = args;
if (!slugs.length) throw new Error('usage: places-take.ts <slug> [<slug>...] [--seconds 9]');
fs.mkdirSync(out, { recursive: true });
const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright');
const browser = await chromium.launch();
// Where the hero is sent, as fractions of the picture: across the floor and back.
const steps = [[0.3, 0.86], [0.68, 0.8], [0.5, 0.9]];
let port = 4197;
for (const slug of slugs) {
  const files = new WorldFiles(slug);
  const places = fs.readdirSync(files.path('places')).filter((p) => fs.existsSync(files.path('places', p, 'painting.png')));
  const server = await serveWorld(files, ++port);
  for (const place of places) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, recordVideo: { dir: path.join(out, 'raw'), size: { width: 1440, height: 1080 } } });
    const page = await context.newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}/?place=${encodeURIComponent(place)}&parallax=1.5&track=1&sway=1&cursor=0`);
      await page.waitForTimeout(3000);
      for (const [x, y] of steps) {
        await page.mouse.click(1440 * x, 1080 * y);
        await page.waitForTimeout((seconds * 1000) / steps.length);
      }
    } finally {
      const recorded = page.video();
      await context.close();
      const raw = await recorded?.path();
      // The first 3 s are the page loading.
      if (raw) execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '3', '-i', raw, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-crf', '20', '-r', '30', path.join(out, `${slug}--${place}.mp4`)]);
      console.log(`${slug}--${place}.mp4`);
    }
  }
  server.close();
}
await browser.close();
fs.rmSync(path.join(out, 'raw'), { recursive: true, force: true });
