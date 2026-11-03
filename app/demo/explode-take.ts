// The diorama taken apart, for the film: a place's painting turns in 3D and comes apart into what Diorama made
// of it (the backdrop with its things taken out, the far flats, each cut-out card at its own depth), holds, turns
// back and closes into the painting again. Built from the build's own files, rendered frame by frame (smooth.ts).
//   npx tsx app/demo/explode-take.ts <slug> <place> [--seconds 9] [--style turn|orbit-popout] [--out app/demo/footage/explode]
// Writes <slug>--<place>.mp4 (1920x1080).
//   turn (default): the painting turns a quarter and its layers part along depth, slowly (a 9 s take).
//   orbit-popout: a 4 s take for the X clip. The camera swings round the floating diorama while the backdrop parts
//   into three depth slices (sky, far, near) and its cloud bands, and every card pops out towards the camera; flat,
//   the painting sits EXPLODE_FLAT_SCALE times its frame size in the middle of the render (diorama clip cuts round it).
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import sharp from 'sharp';
import { EXPLODE_FLAT_SCALE } from '../src/film/clip.ts';
import { takeOption } from '../src/registry.ts';
import { WorldFiles } from '../src/world/files.ts';
import { HOLD_FRAMES, smoothTake } from './smooth.ts';

const args = process.argv.slice(2);
const out = path.resolve(takeOption(args, 'out', 'app/demo/footage/explode'));
const style = takeOption(args, 'style', 'turn');
const seconds = Number(takeOption(args, 'seconds', style === 'orbit-popout' ? '4' : '9'));
const [slug, place] = args.filter((a) => !a.startsWith('--'));
if (!slug || !place) throw new Error('usage: explode-take.ts <slug> <place> [--seconds 9] [--style turn|orbit-popout]');
if (style !== 'turn' && style !== 'orbit-popout') throw new Error(`--style is turn or orbit-popout, not ${style}`);
const files = new WorldFiles(slug);
const dir = files.path('places', place);
const work = path.join(out, `${slug}--${place}`);
fs.mkdirSync(work, { recursive: true });

type Box = [number, number, number, number];
type Occ = { key: string; mask: string; baseY: number };
type Card = Occ & { box: Box };
const geometry = JSON.parse(fs.readFileSync(path.join(dir, 'geometry.json'), 'utf8')) as { frame: { width: number; height: number }; occluders: Card[] };
const { width: W, height: H } = geometry.frame;
const painting = path.join(dir, 'painting.png');
const backdrop = fs.existsSync(path.join(dir, 'backdrop.png')) ? path.join(dir, 'backdrop.png') : painting;
const flatsFile = path.join(dir, 'layers.json');
const layersJson = (fs.existsSync(flatsFile) ? JSON.parse(fs.readFileSync(flatsFile, 'utf8')) : {}) as {
  flats?: Array<{ file: string; box: Box }>;
  clouds?: { box: Box; clip: string; keep?: string; bands: Array<{ file: string; box: Box }> };
};
const flats = layersJson.flats ?? [];

// Each card: the painting's own pixels under its SAM mask, stood at its floor row's depth (nearer = lower = closer).
// Clean for the film: the mask is kept inside the thing's own box (a stray SAM bit of a far wall never flies off with
// the boat), holes the mask leaves inside itself are filled from the painting (an oil can standing in a boat would
// otherwise leave a can-shaped hole in it), and a thing that sits inside a nearer thing's box rides with it, just in
// front, instead of hanging far behind it.
const cards = [...geometry.occluders].filter((o) => fs.existsSync(path.join(dir, o.mask))).sort((a, b) => a.baseY - b.baseY);
const area = (b: number[]) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const inside = (a: number[], b: number[]) => area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]) / Math.max(1, area(a));
const host = (o: Card) => cards.filter((b) => b !== o && b.baseY > o.baseY && area(b.box) > 2 * area(o.box) && inside(o.box, b.box) > 0.6).sort((a, b) => area(a.box) - area(b.box))[0];
const rgb = await sharp(painting).resize(W, H).removeAlpha().raw().toBuffer();

/** A card's alpha over the whole frame and its padded box: the mask inside the box, slots closed, holes filled. */
async function cardAlpha(o: Card): Promise<{ alpha: Buffer; box: Box }> {
  const alpha = await sharp(path.join(dir, o.mask)).resize(W, H).greyscale().raw().toBuffer();
  const pad = 6;
  const [bx0, by0, bx1, by1] = [Math.max(0, o.box[0] - pad), Math.max(0, o.box[1] - pad), Math.min(W, o.box[2] + pad), Math.min(H, o.box[3] + pad)];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x < bx0 || x >= bx1 || y < by0 || y >= by1) alpha[y * W + x] = 0;
  // A slot cut through the card by a thin thing standing in front of it (a post before a boat's stern) is closed:
  // a 10 px closing (grow, then shrink) inside the box.
  closeIn(alpha, W, bx0, by0, bx1, by1, 10);
  // Holes: the empty pixels of the box that the box's edge cannot reach through other empty pixels.
  const bw = bx1 - bx0, bh = by1 - by0;
  const outside = new Uint8Array(bw * bh);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= bw || y >= bh) return;
    const k = y * bw + x;
    if (outside[k] || alpha[(y + by0) * W + x + bx0] >= 128) return;
    outside[k] = 1;
    stack.push(k);
  };
  for (let x = 0; x < bw; x++) push(x, 0), push(x, bh - 1);
  for (let y = 0; y < bh; y++) push(0, y), push(bw - 1, y);
  while (stack.length) {
    const k = stack.pop()!;
    const x = k % bw, y = (k - x) / bw;
    push(x + 1, y), push(x - 1, y), push(x, y + 1), push(x, y - 1);
  }
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (!outside[y * bw + x]) alpha[(y + by0) * W + x + bx0] = 255;
  return { alpha, box: [bx0, by0, bx1, by1] };
}

const html = style === 'orbit-popout' ? await orbitPopoutPage() : await turnPage();
fs.writeFileSync(path.join(work, 'index.html'), html);

const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.addInitScript(HOLD_FRAMES);
await page.goto(`file://${path.join(work, 'index.html')}`);
await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0), undefined, { timeout: 60_000 });
await page.waitForTimeout(1500);
await smoothTake(page, seconds, path.join(out, `${slug}--${place}.mp4`));
await browser.close();
fs.rmSync(work, { recursive: true, force: true });
console.log(path.join(out, `${slug}--${place}.mp4`));

/** The slow turn: whole-frame layers stacked along depth; the clock comes from requestAnimationFrame (smooth.ts steps it). */
async function turnPage(): Promise<string> {
  const layers: Array<{ file: string; z: number; label?: string }> = [];
  fs.copyFileSync(backdrop, path.join(work, 'back.png'));
  layers.push({ file: 'back.png', z: 0 });
  for (const [i, f] of flats.entries()) {
    // A far flat stands in front of the sky, behind everything else.
    const img = await sharp(path.join(dir, f.file)).png().toBuffer();
    await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: img, left: f.box[0], top: f.box[1] }]).png().toFile(path.join(work, `flat-${i}.png`));
    layers.push({ file: `flat-${i}.png`, z: 30 + 20 * i });
  }
  const depth = (o: Card) => 90 + 340 * Math.max(0, Math.min(1, o.baseY / H)) ** 1.5;
  for (const o of cards) {
    const { alpha } = await cardAlpha(o);
    const rgba = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      rgba[i * 4] = rgb[i * 3];
      rgba[i * 4 + 1] = rgb[i * 3 + 1];
      rgba[i * 4 + 2] = rgb[i * 3 + 2];
      rgba[i * 4 + 3] = alpha[i];
    }
    const name = `card-${o.key}.png`;
    await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toFile(path.join(work, name));
    const on = host(o);
    layers.push({ file: name, z: on ? depth(on) + 2 : depth(o), label: o.key.replace(/[-_]+/g, ' ') });
  }
  // Stacked far to near, so a thing riding in front of its host is drawn after it.
  layers.sort((a, b) => a.z - b.z);
  return `<!doctype html><meta charset="utf-8"><style>
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
 const yaw=-28*open+5*Math.sin(t*0.5)*open;const pitch=12*open;const scale=0.82+0.1*(1-open);
 stage.style.transform='scale('+scale+') rotateX('+pitch+'deg) rotateY('+yaw+'deg)';
 imgs.forEach(im=>{im.style.transform='translateZ('+(Number(im.dataset.z)*1.5*open)+'px)'});
 requestAnimationFrame(frame)}
requestAnimationFrame(frame);
</script>`;
}

/**
 * The X clip's explode (variant F): the backdrop in three depth slices with the far flats' place filled from the
 * sides, the cloud bands (and the keep's glow) as their own elements, the far flats, every card cropped to its box
 * with room for its shadow. No borders or box-shadows: each element is clipped 2 px in, and a per-layer filter
 * darkens farther layers and gives a paper-edge and a soft shadow, all gone when the diorama is flat.
 */
async function orbitPopoutPage(): Promise<string> {
  type Layer = { file: string; box: Box; z: number; kind: string };
  const layers: Layer[] = [];
  const raw = async (file: string, w = W, h = H) => new Uint8Array(await sharp(file).resize(w, h, { fit: 'fill' }).ensureAlpha().raw().toBuffer());
  const save = (buf: Uint8Array, w: number, h: number, name: string) => sharp(Buffer.from(buf), { raw: { width: w, height: h, channels: 4 } }).png().toFile(path.join(work, name));

  // The far flats' alpha over the whole frame (a lighthouse), a little grown: cut out of the backdrop and the keep.
  const flatA = new Uint8Array(W * H);
  for (const f of flats) {
    const img = await sharp(path.join(dir, f.file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let y = 0; y < img.info.height; y++) for (let x = 0; x < img.info.width; x++) {
      if (img.data[(y * img.info.width + x) * 4 + 3] < 40) continue;
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const X = f.box[0] + x + dx, Y = f.box[1] + y + dy;
        if (X >= 0 && Y >= 0 && X < W && Y < H) flatA[Y * W + X] = 1;
      }
    }
  }
  // The backdrop in three horizontal depth slices; the flats' place in it filled row by row from its sides.
  const back = await raw(backdrop);
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      if (!flatA[y * W + x]) { x++; continue; }
      let e = x;
      while (e < W && flatA[y * W + e]) e++;
      const l = Math.max(0, x - 1), r = Math.min(W - 1, e);
      for (let k = x; k < e; k++) {
        const f = (k - l) / Math.max(1, r - l);
        for (let c = 0; c < 3; c++) back[(y * W + k) * 4 + c] = Math.round(back[(y * W + l) * 4 + c] * (1 - f) + back[(y * W + r) * 4 + c] * f);
      }
      x = e;
    }
  }
  const slices: Array<[string, number, number, number]> = [['sky', 0, 0.36, 0], ['far', 0.36, 0.58, 90], ['near', 0.58, 1, 160]];
  for (const [name, a, b, z] of slices) {
    const buf = new Uint8Array(back);
    for (let y = 0; y < H; y++) if (y < Math.round(a * H) || y >= Math.round(b * H)) for (let x = 0; x < W; x++) buf[(y * W + x) * 4 + 3] = 0;
    await save(buf, W, H, `slice-${name}.png`);
    layers.push({ file: `slice-${name}.png`, box: [0, 0, W, H], z, kind: name });
  }
  // Cloud bands, each cut by the cloud clip as the game draws them, then the keep (a glow) over them.
  const cl = layersJson.clouds;
  if (cl?.bands?.length && fs.existsSync(path.join(dir, cl.clip))) {
    const [cw, ch] = [cl.box[2] - cl.box[0], cl.box[3] - cl.box[1]];
    const clip = await raw(path.join(dir, cl.clip), cw, ch);
    for (const [i, b] of cl.bands.entries()) {
      if (!fs.existsSync(path.join(dir, b.file))) continue;
      const bw = b.box[2] - b.box[0], bh = b.box[3] - b.box[1];
      const buf = await raw(path.join(dir, b.file), bw, bh);
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        const X = b.box[0] + x - cl.box[0], Y = b.box[1] + y - cl.box[1];
        const ca = X >= 0 && Y >= 0 && X < cw && Y < ch ? clip[(Y * cw + X) * 4 + 3] : 0;
        buf[(y * bw + x) * 4 + 3] = Math.round((buf[(y * bw + x) * 4 + 3] * ca) / 255);
      }
      await save(buf, bw, bh, `cloud-${i}.png`);
      layers.push({ file: `cloud-${i}.png`, box: b.box, z: 20 + 15 * i, kind: 'cloud' });
    }
    if (cl.keep && fs.existsSync(path.join(dir, cl.keep))) {
      const buf = await raw(path.join(dir, cl.keep), cw, ch);
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (flatA[(y + cl.box[1]) * W + x + cl.box[0]]) buf[(y * cw + x) * 4 + 3] = 0;
      await save(buf, cw, ch, 'keep.png');
      layers.push({ file: 'keep.png', box: cl.box, z: 20 + 15 * cl.bands.length, kind: 'keep' });
    }
  }
  for (const [i, f] of flats.entries()) {
    fs.copyFileSync(path.join(dir, f.file), path.join(work, `flat-${i}.png`));
    layers.push({ file: `flat-${i}.png`, box: f.box, z: 110 + 5 * i, kind: 'flat' });
  }
  // Cards cropped to their box with 40 px of transparent room each side (the drop-shadows fall inside the clip).
  const depth = (o: Card) => 200 + 260 * Math.max(0, Math.min(1, o.baseY / H)) ** 1.5;
  for (const o of cards) {
    const { alpha, box: [bx0, by0, bx1, by1] } = await cardAlpha(o);
    const room = 40;
    const box: Box = [bx0 - room, by0 - room, bx1 + room, by1 + room];
    const cw = box[2] - box[0], ch = box[3] - box[1];
    const buf = new Uint8Array(cw * ch * 4);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const X = x + box[0], Y = y + box[1];
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
      const i = Y * W + X, k = (y * cw + x) * 4;
      buf[k] = rgb[i * 3], buf[k + 1] = rgb[i * 3 + 1], buf[k + 2] = rgb[i * 3 + 2], buf[k + 3] = alpha[i];
    }
    const name = `card-${o.key.replace(/[^a-z0-9-]+/gi, '_')}.png`;
    await save(buf, cw, ch, name);
    const on = host(o);
    layers.push({ file: name, box, z: on ? depth(on) + 4 : depth(o), kind: 'card' });
  }
  layers.sort((a, b) => a.z - b.z);
  const maxZ = Math.max(...layers.map((l) => l.z));
  const els = layers.map((l, i) => ({ ...l, i, zn: l.z / maxZ }));
  const s = EXPLODE_FLAT_SCALE;
  return `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:radial-gradient(ellipse at 50% 45%,#1c2336,#090a10 70%,#050608)}
#cam{position:absolute;left:50%;top:50%;width:${W}px;height:${H}px;margin:-${H / 2}px 0 0 -${W / 2}px;perspective:2600px;perspective-origin:50% 45%}
#stage{position:absolute;inset:0;transform-style:preserve-3d}
#stage img{position:absolute;display:block;border:0;outline:0;box-shadow:none;clip-path:inset(2px);backface-visibility:visible}
</style><div id="cam"><div id="stage">${els
    .map((e) => `<img src="${e.file}" style="left:${e.box[0]}px;top:${e.box[1]}px;width:${e.box[2] - e.box[0]}px;height:${e.box[3] - e.box[1]}px">`)
    .join('')}</div></div>
<script>
const els=${JSON.stringify(els.map(({ kind, i, z, zn }) => ({ kind, i, z, zn })))};
const clamp=x=>x<0?0:x>1?1:x;
const E=x=>{x=clamp(x);return x*x*x*(x*(x*6-15)+10)};
const win=(t,a,b)=>E((t-a)/(b-a));
const backZ={sky:-520,cloud:-470,keep:-370,far:-310,flat:-270,near:-120};
function motion(t){
  const g=win(t,0.3,1.4)-win(t,2.7,3.8);
  const u=win(t,0.3,3.8);
  const yaw=-30*Math.sin(2*Math.PI*u);
  const k=${s}-0.32*g;
  const stage='scale3d('+k+','+k+','+k+') rotateX('+(10*g)+'deg) rotateY('+yaw+'deg)';
  return {stage,els:els.map(e=>{
    const bob=7*Math.sin(2*Math.PI*0.55*t+e.i*1.7);
    if(e.kind!=='card'){
      const d=0.015*e.i;
      const s=win(t,0.3+d,1.4+d)-win(t,2.7+0.2-d,3.8-d*0.3);
      const z=(backZ[e.kind]+(e.kind==='cloud'?e.i*14:0));
      const dy={sky:-50,cloud:-60,keep:-50,far:-10,flat:-20,near:30}[e.kind];
      return {o:clamp(s),tf:'translate3d(0,'+(dy*s+bob*s)+'px,'+(z*s+e.i*0.01)+'px)'};
    }
    const d=0.06*((e.i*3)%7);
    const s=win(t,0.45+d,1.55+d)-win(t,2.55+0.3-d,3.7+0.1-d*0.3);
    const z=380+(e.z-200)*2.2;
    return {o:clamp(s),tf:'translate3d(0,'+(-24*s+bob*s)+'px,'+(z*s+e.i*0.01)+'px)'};
  })};
}
const stageEl=document.getElementById('stage');const imgs=[...stageEl.querySelectorAll('img')];
function filt(e,o){if(o<0.004)return 'none';const b=1-0.42*(1-e.zn)*o;
 return 'brightness('+b.toFixed(3)+') drop-shadow(0 0 2px rgba(18,12,6,'+(0.75*o).toFixed(3)+')) drop-shadow(0 14px 20px rgba(0,0,0,'+(0.5*o).toFixed(3)+'))'}
function render(t){const m=motion(t);stageEl.style.transform=m.stage;
 m.els.forEach((r,k)=>{imgs[k].style.transform=r.tf;imgs[k].style.filter=filt(els[k],r.o)})}
function frame(now){render(now/1000);requestAnimationFrame(frame)}
requestAnimationFrame(frame);
</script>`;
}

/** Morphological closing of a 0..255 mask inside [x0,y0,x1,y1): square max then square min, r pixels. */
function closeIn(a: Buffer, W: number, x0: number, y0: number, x1: number, y1: number, r: number) {
  const bw = x1 - x0, bh = y1 - y0;
  let m = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) m[y * bw + x] = a[(y + y0) * W + x + x0] >= 128 ? 1 : 0;
  const pass = (src: Uint8Array, grow: boolean, horizontal: boolean) => {
    const out = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      let v = grow ? 0 : 1;
      for (let k = -r; k <= r; k++) {
        const [xx, yy] = horizontal ? [x + k, y] : [x, y + k];
        const s = xx < 0 || yy < 0 || xx >= bw || yy >= bh ? (grow ? 0 : 1) : src[yy * bw + xx];
        if (grow ? s : !s) { v = grow ? 1 : 0; break; }
      }
      out[y * bw + x] = v;
    }
    return out;
  };
  m = pass(pass(pass(pass(m, true, true), true, false), false, true), false, false);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (m[y * bw + x]) a[(y + y0) * W + x + x0] = 255;
}
