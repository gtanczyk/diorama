// A character as Diorama makes it, for the film, from the build's own files: the painted figure, then the four
// sides Muse painted for the 3D model fanning out of it, turning slowly, then folding back. No Studio, no
// screen recording: the page is drawn from cast/ and stepped frame by frame (smooth.ts).
//   npx tsx app/demo/character-take.ts <slug> <key> [--seconds 9] [--out app/demo/footage/character]
// Writes <slug>--<key>.mp4 (1920x1080).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { takeOption } from '../src/registry.ts';
import { WorldFiles } from '../src/world/files.ts';
import { HOLD_FRAMES, smoothTake } from './smooth.ts';

const args = process.argv.slice(2);
const out = path.resolve(takeOption(args, 'out', 'app/demo/footage/character'));
const seconds = Number(takeOption(args, 'seconds', '9'));
const [slug, key] = args;
if (!slug || !key) throw new Error('usage: character-take.ts <slug> <key> [--seconds 9]');
const files = new WorldFiles(slug);
const work = path.join(out, `${slug}--${key}`);
fs.mkdirSync(work, { recursive: true });

const painting = files.path('cast', `${key}-painting.png`);
if (!fs.existsSync(painting)) throw new Error(`no painting for ${key}: ${painting}`);
fs.copyFileSync(painting, path.join(work, 'painting.png'));
const sides = ['front', 'left', 'back', 'right'].filter((v) => fs.existsSync(files.path('cast', key, 'model', `${v}.png`)));
for (const v of sides) fs.copyFileSync(files.path('cast', key, 'model', `${v}.png`), path.join(work, `${v}.png`));

const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:radial-gradient(ellipse at 50% 45%,#1d2436,#07080c 75%)}
img{position:absolute;left:50%;top:50%;height:760px;transform-origin:50% 50%;will-change:transform,opacity}
.side{height:560px;border-radius:18px;background:#d9d9d9;box-shadow:0 20px 60px #0009}
</style>
<img id="p" src="painting.png">
${sides.map((v) => `<img class="side" src="${v}.png">`).join('')}
<script>
const T=${seconds};const ease=x=>x<0?0:x>1?1:x*x*(3-2*x);
const p=document.getElementById('p');const s=[...document.querySelectorAll('.side')];
function frame(now){const t=now/1000;
 // The painted figure, then the sides fan out of it (20-45%), hold with a slow sway, fold back in the last 18%.
 const open=ease((t-T*0.2)/(T*0.25))-ease((t-T*0.82)/(T*0.16));
 p.style.opacity=String(1-0.85*open);
 p.style.transform='translate(-50%,-50%) scale('+(1-0.15*open)+')';
 s.forEach((im,i)=>{const n=s.length;const x=(i-(n-1)/2)*400*open;const tilt=(i-(n-1)/2)*-6*open+3*Math.sin(t*0.8+i)*open;
  im.style.opacity=String(open);im.style.transform='translate(-50%,-50%) translateX('+x+'px) rotate('+tilt+'deg) scale('+(0.6+0.4*open)+')'});
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
await smoothTake(page, seconds, path.join(out, `${slug}--${key}.mp4`));
await browser.close();
fs.rmSync(work, { recursive: true, force: true });
console.log(path.join(out, `${slug}--${key}.mp4`));
