import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { expect, test } from 'vitest';
import { MOUTHS } from '../src/play/lipsync.ts';
import { faceSourceHash, rigFingerprint, sha256 } from '../src/scene/faces-data.ts';
import { serveWorld } from '../src/commands/play.ts';
import { WorldFiles } from '../src/world/files.ts';
import { scene } from './fixtures/scene.ts';

function silence() {
  const n = 80000, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40); return b;
}

test.each(['image', 'rig', 'parts'])('the %s renderer changes actual face pixels on speech and closes them on interruption', async mode => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'faces-render-'));
  const { put } = await scene(root, true), files = new WorldFiles('w', root);
  const figure = await sharp(Buffer.from('<svg width="100" height="200"><rect width="100" height="200" fill="#999"/></svg>')).png().toBuffer();
  put('cast/guard.png', figure);
  const colours = ['#0044ff', '#0044ff', '#0044ff', '#0044ff', '#ff2200', '#0044ff', '#0044ff', '#0044ff', '#0044ff'];
  const atlas = await sharp(Buffer.from(`<svg width="90" height="10">${colours.map((c, i) => `<rect x="${i * 10}" width="10" height="10" fill="${c}"/>`).join('')}</svg>`)).png().toBuffer();
  put('cast/guard/face-atlas.png', atlas);
  const info: any = { image: 'face-atlas.png', mouths: Object.fromEntries(MOUTHS.map((m, i) => [m, [i * 10, 0, 10, 10]])), imageHash: sha256(figure), anchors: {default:[0.25,0.35,0.5,0.2]}, frames:{default:Object.fromEntries(MOUTHS.map(m=>[m,[0.25,0.35,0.5,0.2]]))}, imagePose: { mouth: [40, 25, 20, 15], lips:[45,29,10,3], eyes: [] }, sheets: {}, sheetHashes: {} };
  if (mode !== 'image') {
    const rig = { size: [300, 240], ground: 230, height: 190, hip: [150, 125], shoulder: { near: [170, 80], far: [130, 80] }, leg: { near: { knee: [160, 175], ankle: [160, 225] }, far: { knee: [140, 175], ankle: [140, 225] } }, parts: [], sheet: { file: 'walk.png', cols: 3, rows: 1, frames: 2, cell: [300, 240], scale: 1 } };
    if (mode === 'parts') {
      delete (rig as any).sheet;
      (rig as any).parts = [{name:'torso',file:'torso.png',at:[100,20]}];
      put('cast/guard/torso.png',figure);
    }
    put('cast/guard/rig.json', rig);
    const walk = await sharp({create:{width:900,height:240,channels:4,background:'#0000'}}).composite([0,1,2].map(i=>({input:figure,left:i*300+100,top:20}))).png().toBuffer();
    put('cast/guard/walk.png', walk);
    info.sheets['rig:walk.png'] = [0, 1, 2].map(() => ({ mouth: [140, 45, 20, 15], lips:[145,49,10,3], eyes: [] }));
    if (mode === 'parts') {
      info.sheets = {}; info.rigPose = {mouth:[140,45,20,15],lips:[145,49,10,3],eyes:[]}; info.rigHash=rigFingerprint(files,'guard');
    } else info.sheetHashes['rig:walk.png'] = faceSourceHash(files, 'guard', 'rig:walk.png');
  }
  put('cast/guard/face.json', info);
  const server = await serveWorld(files, 0), browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage();
    await page.route('**/world-data.json', async route => {
      const response = await route.fetch(), data = await response.json();
      data.sound = { files: {}, places: {}, shots: {}, bySpeaker: { guard: { 'Hello.': { file: 'voice.wav', seconds: 10, lipsync: { cues: [{ start: 0, end: 10, value: 'D' }] } } } } };
      await route.fulfill({ response, json: data });
    });
    await page.route('**/files/voice.wav', route => route.fulfill({ contentType: 'audio/wav', body: silence() }));
    await page.goto(`http://127.0.0.1:${(server.address() as {port:number}).port}/?place=room&parallax=0&rim=0&separate=0`);
    await page.waitForFunction(() => (window as any).diorama?.place && (window as any).diorama.dark === 0);
    const result = await page.evaluate(async mode => {
      const g = (window as any).diorama, c = (document.querySelector('#view') as HTMLCanvasElement).getContext('2d')!;
      const pixel = () => {
        const data = c.getImageData(480,390,40,80).data; let red=0,blue=0;
        for(let i=0;i<data.length;i+=4){if(data[i]>data[i+2]+70)red++;if(data[i+2]>data[i]+70)blue++;}
        return {red,blue};
      };
      const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      await frame(); const before = pixel();
      await g.sound.ctx.resume(); void g.say('Hello.', 'guard');
      const deadline=performance.now()+5000;
      while(g.sound.mouth(g.speech).mouth!=='D'&&performance.now()<deadline) await new Promise(r=>setTimeout(r,20));
      await frame(); const during = pixel();
      g.emit('silent', {}); await frame(); const after = pixel();
      return { before, during, after, rig: !!g.figures.get('guard').rig };
    }, mode);
    expect(result.rig).toBe(mode !== 'image');
    expect(result.before.blue).toBe(0);
    expect(result.during.red).toBeGreaterThan(10);
    expect(result.after).toEqual(result.before);
  } finally { await browser.close(); await new Promise<void>(r => server.close(() => r())); fs.rmSync(root, {recursive:true,force:true}); }
}, 15_000);
