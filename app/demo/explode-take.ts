// The diorama taken apart, for the film: a place's painting turns in 3D and comes apart into what Diorama made
// of it (the backdrop with its things taken out, the far flats, each cut-out card at its own depth), holds, turns
// back and closes into the painting again. Built from the build's own files, rendered frame by frame (smooth.ts).
//   npx tsx app/demo/explode-take.ts <slug> <place> [--seconds 9] [--out app/demo/footage/explode]
// Writes <slug>--<place>.mp4 (1920x1080).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import sharp from 'sharp';
import { takeOption } from '../src/registry.ts';
import { WorldFiles } from '../src/world/files.ts';
import { HOLD_FRAMES, smoothTake } from './smooth.ts';

const args = process.argv.slice(2);
const out = path.resolve(takeOption(args, 'out', 'app/demo/footage/explode'));
const seconds = Number(takeOption(args, 'seconds', '9'));
const [slug, place] = args;
if (!slug || !place) throw new Error('usage: explode-take.ts <slug> <place> [--seconds 9]');
const files = new WorldFiles(slug);
const dir = files.path('places', place);
const work = path.join(out, `${slug}--${place}`);
fs.mkdirSync(work, { recursive: true });

type Occ = { key: string; mask: string; baseY: number };
const geometry = JSON.parse(fs.readFileSync(path.join(dir, 'geometry.json'), 'utf8')) as { frame: { width: number; height: number }; occluders: Occ[] };
const { width: W, height: H } = geometry.frame;
const painting = path.join(dir, 'painting.png');
const backdrop = fs.existsSync(path.join(dir, 'backdrop.png')) ? path.join(dir, 'backdrop.png') : painting;

// Layers far to near: z in px towards the camera.
const layers: Array<{ file: string; z: number; label?: string }> = [];
fs.copyFileSync(backdrop, path.join(work, 'back.png'));
layers.push({ file: 'back.png', z: 0 });
const flatsFile = path.join(dir, 'layers.json');
const flats = fs.existsSync(flatsFile) ? (JSON.parse(fs.readFileSync(flatsFile, 'utf8')) as { flats: Array<{ file: string; box: [number, number, number, number] }> }).flats : [];
for (const [i, f] of flats.entries()) {
  // A far flat stands in front of the sky, behind everything else.
  const img = await sharp(path.join(dir, f.file)).png().toBuffer();
  await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: img, left: f.box[0], top: f.box[1] }]).png().toFile(path.join(work, `flat-${i}.png`));
  layers.push({ file: `flat-${i}.png`, z: 30 + 20 * i });
}
// Each card: the painting's own pixels under its SAM mask, stood at its floor row's depth (nearer = lower = closer).
const cards = [...geometry.occluders].filter((o) => fs.existsSync(path.join(dir, o.mask))).sort((a, b) => a.baseY - b.baseY);
for (const o of cards) {
  const alpha = await sharp(path.join(dir, o.mask)).resize(W, H).greyscale().raw().toBuffer();
  const rgb = await sharp(painting).resize(W, H).removeAlpha().raw().toBuffer();
  const rgba = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = rgb[i * 3];
    rgba[i * 4 + 1] = rgb[i * 3 + 1];
    rgba[i * 4 + 2] = rgb[i * 3 + 2];
    rgba[i * 4 + 3] = alpha[i];
  }
  const name = `card-${o.key}.png`;
  await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toFile(path.join(work, name));
  layers.push({ file: name, z: 90 + 340 * Math.max(0, Math.min(1, o.baseY / H)) ** 1.5, label: o.key.replace(/[-_]+/g, ' ') });
}

// One page: the layers stacked in CSS 3D; the clock comes from requestAnimationFrame, which smooth.ts steps.
const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:radial-gradient(ellipse at 50% 40%,#1b2133,#07080c 75%)}
#cam{position:absolute;left:50%;top:50%;width:${W}px;height:${H}px;margin:-${H / 2}px 0 0 -${W / 2}px;perspective:2200px}
#stage{position:absolute;inset:0;transform-style:preserve-3d}
#stage img{position:absolute;left:0;top:0;width:${W}px;height:${H}px}
#stage .back{box-shadow:0 30px 80px rgba(0,0,0,.6)}
</style><div id="cam"><div id="stage">${layers.map((l, i) => `<img class="${i ? '' : 'back'}" src="${l.file}" data-z="${l.z}">`).join('')}</div></div>
<script>
const stage=document.getElementById('stage');const imgs=[...stage.querySelectorAll('img')];
const T=${seconds};const ease=x=>x<0?0:x>1?1:x*x*(3-2*x);
function frame(now){const t=now/1000;
 // 0..15% flat, then open, hold with a slow orbit, close in the last 20%.
 const open=ease((t-T*0.12)/(T*0.28))-ease((t-T*0.78)/(T*0.2));
 const yaw=-34*open+6*Math.sin(t*0.5)*open;const pitch=12*open;const scale=0.82+0.1*(1-open);
 stage.style.transform='scale('+scale+') rotateX('+pitch+'deg) rotateY('+yaw+'deg)';
 imgs.forEach(im=>{im.style.transform='translateZ('+(Number(im.dataset.z)*2.2*open)+'px)'});
 requestAnimationFrame(frame)}
requestAnimationFrame(frame);
</script>`;
fs.writeFileSync(path.join(work, 'index.html'), html);

const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.addInitScript(HOLD_FRAMES);
await page.goto(`file://${path.join(work, 'index.html')}`);
await page.waitForTimeout(1500);
await smoothTake(page, seconds, path.join(out, `${slug}--${place}.mp4`));
await browser.close();
fs.rmSync(work, { recursive: true, force: true });
console.log(path.join(out, `${slug}--${place}.mp4`));
