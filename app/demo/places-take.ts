// The game itself for the film: every place of the given worlds (or only --places a,b), the hero walking a few
// steps with the tracking camera and parallax on, one clip per place, stepped frame by frame so it plays smooth
// at 30 fps whatever the machine (smooth.ts). --walk 0 hides everyone (?people=0): the place alone, alive.
// Free: it only plays what the builds made.
//   npx tsx app/demo/places-take.ts <slug> [<slug>...] [--places a,b] [--seconds 9] [--walk 1] [--out app/demo/footage/places]
// Writes <slug>--<place>.mp4 (1440x1080, the game's 4:3) per place.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { serveWorld } from '../src/commands/play.ts';
import { takeOption } from '../src/registry.ts';
import { WorldFiles } from '../src/world/files.ts';
import { HOLD_FRAMES, smoothTake } from './smooth.ts';

const args = process.argv.slice(2);
const out = path.resolve(takeOption(args, 'out', 'app/demo/footage/places'));
const seconds = Number(takeOption(args, 'seconds', '9'));
const only = takeOption(args, 'places', '').split(',').filter(Boolean);
const walking = takeOption(args, 'walk', '1') !== '0';
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
  const places = fs.readdirSync(files.path('places')).filter((p) => fs.existsSync(files.path('places', p, 'painting.png')) && (!only.length || only.includes(p)));
  const server = await serveWorld(files, ++port);
  for (const place of places) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
    await page.addInitScript(HOLD_FRAMES);
    await page.goto(`http://127.0.0.1:${port}/?place=${encodeURIComponent(place)}&capture=1&parallax=1.5&track=1&sway=1&glow=1&separate=1&rim=1${walking ? '' : '&people=0'}`);
    // Loaded: the first frames draw once the place's pictures are in.
    await page.waitForTimeout(2500);
    await page.evaluate(() => (window as unknown as { __step: (n: number) => void }).__step(30));
    const clicks = walking ? steps.map(([x, y], i) => [(i * seconds) / steps.length, () => page.mouse.click(1440 * x, 1080 * y)] as [number, () => Promise<void>]) : [];
    await smoothTake(page, seconds, path.join(out, `${slug}--${place}.mp4`), clicks);
    await page.close();
    console.log(`${slug}--${place}.mp4`);
  }
  server.close();
}
await browser.close();
