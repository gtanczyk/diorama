// "How it's made" for the film, from one place's build files: the plan, the painting, SAM's cut-outs over it, the
// depth map, the empty stage behind the cards and the walkable floor as stills, then the place live with its
// parallax pushed so the layers show. Free: it only reads what the build left.
//   npx tsx app/demo/method-take.ts <slug> <place> [--out app/demo/footage/method] [--seconds 10]
// Writes 1-plan.png ... 6-walk.png (1920x1080) and parallax.mp4.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import sharp from 'sharp';
import { serveWorld } from '../src/commands/play.ts';
import { takeOption } from '../src/registry.ts';
import { WorldFiles } from '../src/world/files.ts';

const args = process.argv.slice(2);
const out = path.resolve(takeOption(args, 'out', 'app/demo/footage/method'));
const seconds = Number(takeOption(args, 'seconds', '10'));
const [slug, place] = args;
if (!slug || !place) throw new Error('usage: method-take.ts <slug> <place> [--out dir]');
const files = new WorldFiles(slug);
const dir = files.path('places', place);
fs.mkdirSync(out, { recursive: true });

const W = 1920, H = 1080, PW = Math.round((H * 1200) / 896);
/** A place-sized picture centred on the film's dark ground. */
const still = async (name: string, picture: sharp.Sharp) => {
  const fitted = await picture.resize(PW, H).png().toBuffer();
  await sharp({ create: { width: W, height: H, channels: 4, background: '#0b0b10' } })
    .composite([{ input: fitted, left: Math.round((W - PW) / 2), top: 0 }]).png().toFile(path.join(out, name));
};
const painting = path.join(dir, 'painting.png');
await still('1-plan.png', sharp(path.join(dir, 'plan.png')).flatten({ background: '#ffffff' }));
await still('2-painting.png', sharp(painting));
const overlay = await sharp(path.join(dir, 'masks', 'overlay.png')).resize(1200, 896).png().toBuffer();
await still('3-masks.png', sharp(await sharp(painting).modulate({ brightness: 0.7 }).composite([{ input: overlay }]).png().toBuffer()));
// Depth as heat: near is warm, far is cold, so it reads at a glance. depth.png keeps rows below the horizon in
// R (high byte) and G (low byte), see src/scene/depthmap.ts; more rows = nearer.
const rgb = await sharp(path.join(dir, 'depth.png')).removeAlpha().resize(1200, 896, { kernel: 'nearest' }).raw().toBuffer();
const rows = new Float32Array(1200 * 896);
let most = 1;
for (let i = 0; i < rows.length; i++) most = Math.max(most, (rows[i] = rgb[i * 3] * 256 + rgb[i * 3 + 1]));
const heat = Buffer.alloc(1200 * 896 * 3);
for (let i = 0; i < rows.length; i++) {
  const t = Math.sqrt(rows[i] / most);
  heat[i * 3] = Math.round(255 * Math.min(1, 0.15 + t * 1.3));
  heat[i * 3 + 1] = Math.round(255 * Math.max(0, Math.min(1, t * 1.6 - 0.55)));
  heat[i * 3 + 2] = Math.round(255 * Math.max(0, 0.6 - t * 1.1));
}
await still('4-depth.png', sharp(heat, { raw: { width: 1200, height: 896, channels: 3 } }));
if (fs.existsSync(path.join(dir, 'backdrop.png'))) await still('5-backdrop.png', sharp(path.join(dir, 'backdrop.png')));
const walk = await sharp(path.join(dir, 'walk.png')).resize(1200, 896).png().toBuffer();
await still('6-walk.png', sharp(await sharp(painting).modulate({ brightness: 0.75 }).composite([{ input: walk, blend: 'over' }]).png().toBuffer()));

// The place live, parallax strong and swaying, so the cut-outs separate from the painting behind them.
const port = 4196;
const server = await serveWorld(files, port);
const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright');
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: path.join(out, 'raw'), size: { width: W, height: H } } });
const page = await context.newPage();
try {
  await page.goto(`http://127.0.0.1:${port}/?place=${encodeURIComponent(place)}&parallax=2.5&sway=1&cursor=0`);
  await page.waitForTimeout(seconds * 1000 + 3000);
} finally {
  const recorded = page.video();
  await context.close();
  await browser.close();
  server.close();
  const raw = await recorded?.path();
  // The first 3 s are the page loading.
  if (raw) execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '3', '-i', raw, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-crf', '20', '-r', '30', path.join(out, 'parallax.mp4')]);
  fs.rmSync(path.join(out, 'raw'), { recursive: true, force: true });
}
console.log(out);
