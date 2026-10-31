import { build } from 'esbuild';
import sharp from 'sharp';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { Figure3D, ModelInfo } from '../web/hero3d.ts';
import { boxGlb } from './fixtures/model-box.ts';

let browser: Browser, source: string, png: Buffer;
beforeAll(async () => {
  source = (await build({ entryPoints: ['app/web/hero3d.ts'], bundle: true, format: 'iife', globalName: 'Figures', write: false })).outputFiles[0].text;
  png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#dddddd' } }).png().toBuffer();
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => browser?.close());

async function open(glb: Buffer): Promise<Page> {
  const page = await browser.newPage();
  await page.route('http://model.test/**', (r) => {
    const name = new URL(r.request().url()).pathname;
    return r.fulfill(name === '/model.glb' ? { body: glb, contentType: 'model/gltf-binary' }
      : name.endsWith('.png') ? { body: png, contentType: 'image/png' }
      : { body: '<!doctype html><body></body>', contentType: 'text/html' });
  });
  await page.goto('http://model.test/');
  await page.addScriptTag({ content: source });
  return page;
}

declare global {
  interface Window { Figures: { Figure3D: typeof Figure3D } }
}
const info: ModelInfo = {
  glb: 'model.glb', creature: true,
  views: Object.fromEntries(['front', 'back', 'left', 'right'].map((name) => [name, { image: `${name}.png`, u: [1, 0.5], v: [-1, 1], iou: 1 }])) as ModelInfo['views'],
};

test('a creature uses the same frame regardless of source mesh scale and offset', async () => {
  const frames: number[][] = [];
  for (const glb of [boxGlb([1.2, 1, 0.4]), boxGlb([1.2, 1, 0.4], 0.01, [0.2, 0.4, -0.3])]) {
    const page = await open(glb);
    try {
      const result = await page.evaluate(async (info) => {
        const fig = await window.Figures.Figure3D.load(info, (f) => '/' + f);
        fig.plain();
        const canvas = fig.draw({ phase: 0, walking: false, yaw: 0.6, px: 320 });
        const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height;
        const ctx = copy.getContext('2d')!; ctx.drawImage(canvas, 0, 0);
        const pixels = ctx.getImageData(0, 0, copy.width, copy.height).data;
        let visible = 0, clear = 0;
        for (let i = 3; i < pixels.length; i += 4) { if (pixels[i]) visible++; else clear++; }
        const out = { frame: [canvas.width, canvas.height], visible, clear, error: canvas.getContext('webgl2')!.getError() };
        fig.dispose(); return out;
      }, info);
      expect(result.error).toBe(0);
      expect(result.visible).toBeGreaterThan(100);
      expect(result.clear).toBeGreaterThan(100);
      expect(result.frame[0]).toBeLessThan(600);
      frames.push(result.frame);
    } finally { await page.close(); }
  }
  expect(Math.abs(frames[0][0] - frames[1][0])).toBeLessThanOrEqual(1);
  expect(frames[0][1]).toBe(frames[1][1]);
}, 30_000);

test('the browser rejects an old horizontal card before allocating its oversized render target', async () => {
  const page = await open(boxGlb([1, 0.043, 1]));
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  try {
    const message = await page.evaluate(async (info) => {
      try { const fig = await window.Figures.Figure3D.load(info, (f) => '/' + f); fig.dispose(); return 'accepted'; }
      catch (e) { return (e as Error).message; }
    }, info);
    expect(message).toContain('flat:');
    expect(errors.filter((s) => /INVALID_VALUE|out of range/.test(s))).toEqual([]);
  } finally { await page.close(); }
}, 30_000);

test('an oversized draw fails before changing the canvas or producing a WebGL error', async () => {
  const page = await open(boxGlb([1.2, 1, 0.4]));
  try {
    const result = await page.evaluate(async (info) => {
      const fig = await window.Figures.Figure3D.load(info, (f) => '/' + f);
      fig.plain();
      const c = fig.draw({ phase: 0, walking: false, yaw: 0, px: 100 });
      const before = [c.width, c.height];
      let message = '';
      try { fig.draw({ phase: 0, walking: false, yaw: 0, px: 1_000_000 }); } catch (e) { message = (e as Error).message; }
      const out = { before, after: [c.width, c.height], message, error: c.getContext('webgl2')!.getError() };
      fig.dispose(); return out;
    }, info);
    expect(result.message).toContain('cannot be rendered safely');
    expect(result.after).toEqual(result.before);
    expect(result.error).toBe(0);
  } finally { await page.close(); }
}, 30_000);

test('model texture mode keeps the UV paint on the body (the paintings only set its brightness and, with face: views, the face)', async () => {
  const red = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const page = await open(boxGlb([1.2, 1, 0.4], 1, [0, 0, 0], red));
  try {
    const result = await page.evaluate(async (info) => {
      const fig = await window.Figures.Figure3D.load({ ...info, texture: 'model' }, (f) => '/' + f, 0);
      const c = fig.draw({ phase: 0, walking: false, yaw: 0, elevation: 0, px: 100 });
      const copy = document.createElement('canvas'); copy.width = c.width; copy.height = c.height;
      const ctx = copy.getContext('2d')!; ctx.drawImage(c, 0, 0);
      const centre = Array.from(ctx.getImageData(c.width >> 1, c.height >> 1, 1, 1).data);
      const error = c.getContext('webgl2')!.getError(); fig.dispose(); return { centre, error };
    }, info);
    expect(result.error).toBe(0);
    expect(result.centre[0]).toBeGreaterThan(150);
    expect(result.centre[1]).toBeLessThan(10);
    expect(result.centre[2]).toBeLessThan(10);
    expect(result.centre[3]).toBe(255);
  } finally { await page.close(); }
}, 30_000);

test('model texture mode rejects a mesh without a UV texture instead of silently projecting views', async () => {
  const page = await open(boxGlb([1.2, 1, 0.4]));
  try {
    const message = await page.evaluate(async (info) => {
      try { const fig = await window.Figures.Figure3D.load({ ...info, texture: 'model' }, (f) => '/' + f); fig.dispose(); return 'accepted'; }
      catch (e) { return (e as Error).message; }
    }, info);
    expect(message).toContain('model texture requires a base colour map and UV coordinates');
  } finally { await page.close(); }
}, 30_000);

test('a 3D mesh without morphs speaks through independent painted surfaces, turns with them and returns to the original paint', async () => {
  const page=await open(boxGlb([1.2,1,0.4]));
  const atlas=await sharp(Buffer.from(`<svg width="144" height="16">${Array.from({length:9},(_,i)=>`<rect x="${i*16}" width="16" height="16" fill="${i===4?'#ff2200':'#dddddd'}"/>`).join('')}</svg>`)).png().toBuffer();
  await page.route('**/faces.png',r=>r.fulfill({body:atlas,contentType:'image/png'}));
  const green=await sharp({create:{width:32,height:32,channels:3,background:'#22bb44'}}).png().toBuffer();
  const blue=await sharp({create:{width:32,height:32,channels:3,background:'#2255bb'}}).png().toBuffer();
  await page.route('**/right.png',r=>r.fulfill({body:green,contentType:'image/png'}));
  await page.route('**/left.png',r=>r.fulfill({body:blue,contentType:'image/png'}));
  try {
    const result=await page.evaluate(async info=>{
      const fig=await window.Figures.Figure3D.load(info,f=>'/'+f,0),atlas=new Image();atlas.src='/faces.png';await atlas.decode();
      const mouths=['X','A','B','C','D','E','F','G','H'] as const;
      const gl=fig.canvas.getContext('webgl2')!;let draws=0;
      for(const name of ['drawElements','drawArrays'] as const){const original=(gl[name] as Function).bind(gl);(gl as any)[name]=(...args:unknown[])=>{draws++;return original(...args);};}
      const anchor:[number,number,number,number]=[0.25,0.3,0.5,0.2];
      fig.setFace({image:'faces.png',mouths:Object.fromEntries(mouths.map((m,i)=>[m,[i*16,0,16,16]])) as any,anchors:{default:anchor},frames:{default:Object.fromEntries(mouths.map(m=>[m,anchor])) as any},sheets:Object.fromEntries(['front','left','right'].map(v=>['model:'+v+'.png',[{mouth:[10,2,12,10],lips:[12,4,8,2],eyes:[]}]]))},atlas);
      const draw=(mouth:'X'|'D',yaw=0)=>{
        const face={mouth,previous:mouth,mix:1,energy:0,blink:0,brow:0,jaw:mouth==='D'?0.9:0,round:0};
        const c=fig.draw({time:0,phase:0,walking:false,yaw,elevation:0,px:240,frame:42,face}),copy=document.createElement('canvas');copy.width=c.width;copy.height=c.height;
        const ctx=copy.getContext('2d')!;ctx.drawImage(c,0,0);const pixels=ctx.getImageData(0,0,c.width,c.height).data;
        let red=0,green=0;for(let i=0;i<pixels.length;i+=4){if(pixels[i+3]&&pixels[i]>pixels[i+1]+60&&pixels[i]>pixels[i+2]+60)red++;if(pixels[i+3]&&pixels[i+1]>pixels[i]+30&&pixels[i+1]>pixels[i+2]+30)green++;}
        return {red,green};
      };
      const before=draw('X'),firstDraws=draws;draw('X');const cached=draws===firstDraws,speaking=draw('D'),profile=draw('D',Math.PI/2),after=draw('X'),caps=fig.facialCapabilities,error=fig.canvas.getContext('webgl2')!.getError();fig.dispose();
      return {before,speaking,profile,after,caps,error,cached};
    },info);
    expect(result.cached).toBe(true);expect(result.caps.method).toBe('painted-surfaces');expect(result.caps.views.sort()).toEqual(['front','left','right']);
    expect(result.before.red).toBe(0);expect(result.speaking.red).toBeGreaterThan(5);expect(result.profile.red).toBeGreaterThan(5);
    expect(result.speaking.green).toBe(0);expect(result.profile.green).toBeGreaterThan(20);expect(result.after).toEqual(result.before);expect(result.error).toBe(0);
  } finally {await page.close();}
},30_000);
