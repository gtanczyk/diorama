import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { WorldFiles } from '../src/world/files.ts';
import { prepareFace } from '../src/scene/faces.ts';
import { registeredFace } from '../src/scene/faces-data.ts';
import { registerRigFace } from '../src/scene/face-registration.ts';
import { offsetFace, type FacePose } from '../src/play/lipsync.ts';

const mocks = vi.hoisted(() => ({ vision: vi.fn(), paint: vi.fn() }));
vi.mock('../src/meta/spark.ts', () => ({ askSparkJson: mocks.vision }));
vi.mock('../src/meta/muse.ts', () => ({ museEdit: mocks.paint }));
let root: string, files: WorldFiles;
const face = { head: [0.2, 0.02, 0.6, 0.3], mouth: [0.4, 0.18, 0.2, 0.09], eyes: [[0.3, 0.1, 0.12, 0.05]], confidence: 0.95 };
const draw = (colour = '#6495ed') => sharp(Buffer.from(`<svg width="128" height="256"><rect x="24" y="8" width="80" height="240" fill="${colour}"/></svg>`)).png().toBuffer();
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-faces-')); files = new WorldFiles('w', root);
  mocks.vision.mockReset(); mocks.paint.mockReset();
  mocks.vision.mockImplementation(async (_memo, ask) => (ask.label.startsWith('face-frame:') || ask.label.startsWith('face-source:') || ask.label.startsWith('face-atlas-lip:')) ? {box:[0.2,0.4,0.5,0.12],confidence:0.95} : ask.label.startsWith('face-lips:') ? { lips: ask.images.map(() => ({box:[0.2,0.4,0.5,0.12],confidence:0.95})) } : ({ poses: Array.from({ length: ask.images.length > 1 ? 9 : 1 }, () => face), matches: true, articulation: true, reason: 'Visible face' }));
  const layers = await Promise.all(Array.from({length:9}, async (_,i) => ({input: await sharp({create:{width:64,height:64,channels:4,background:{r:30+i*20,g:50+i*15,b:70+i*10,alpha:1}}}).png().toBuffer(),left:i%3*64,top:Math.floor(i/3)*64})));
  mocks.paint.mockResolvedValue(await sharp({ create: { width: 192, height: 192, channels: 4, background: '#aabbcc' } }).composite(layers).png().toBuffer());
  const image = await draw();
  files.write(files.path('cast/hero.png'), image);
  files.write(files.path('cast/hero/sprites/talk.png'), image);
  files.write(files.path('cast/hero/sprites/sprites.json'), { cols: 1, rows: 1, talk: { front: { sheet: 'talk.png', gestures: ['listen'] } } });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('face preparation reuses unchanged art and only rebuilds a repainted source', async () => {
  await prepareFace(files, 'hero');
  expect(mocks.paint).toHaveBeenCalledTimes(2);
  const original = registeredFace(files, 'hero')!.info;
  expect(original.imagePose?.lips).toBeDefined(); expect(original.anchors).toBeDefined(); expect(original.sheets['talk.png'][0]).not.toBeNull();
  expect(fs.existsSync(files.path('cast/hero', original.image))).toBe(true);
  const calibrated=mocks.vision.mock.calls.filter(([,ask])=>ask.label.startsWith('face-frame:')).length;
  expect(calibrated).toBe(18);
  await prepareFace(files, 'hero');
  expect(mocks.paint).toHaveBeenCalledTimes(2);
  expect(mocks.vision.mock.calls.filter(([,ask])=>ask.label.startsWith('face-frame:'))).toHaveLength(calibrated);
  files.write(files.path('cast/hero.png'), await draw('#c88040'));
  const stale = registeredFace(files, 'hero')!.info;
  expect(stale.imagePose).toBeUndefined();
  expect(stale.sheets['talk.png']).toEqual(original.sheets['talk.png']);
  await prepareFace(files, 'hero');
  expect(mocks.paint).toHaveBeenCalledTimes(3);
  expect(registeredFace(files, 'hero')!.info.sheets['talk.png']).toEqual(original.sheets['talk.png']);
});

test('a rejected generated atlas never replaces an existing face', async () => {
  await prepareFace(files, 'hero');
  const before = fs.readFileSync(files.path('cast/hero/face.json'));
  mocks.vision.mockImplementation(async (_memo, ask) => (ask.label.startsWith('face-frame:') || ask.label.startsWith('face-source:') || ask.label.startsWith('face-atlas-lip:')) ? {box:[0.2,0.4,0.5,0.12],confidence:0.95} : ask.label.startsWith('face-lips:') ? { lips: ask.images.map(() => ({box:[0.2,0.4,0.5,0.12],confidence:0.95})) } : ({ poses: Array.from({ length: ask.images.length > 1 ? 9 : 1 }, () => face), matches: true, articulation: ask.images.length === 1, reason: 'Mouth shapes identical' }));
  await expect(prepareFace(files, 'hero', { force: true, take: 1 })).rejects.toThrow(/atlas rejected/);
  expect(fs.readFileSync(files.path('cast/hero/face.json')).equals(before)).toBe(true);
});

test('cropped figures register against padded rig art instead of stretching across the canvas', async () => {
  const source = await sharp(Buffer.from('<svg width="100" height="200"><rect x="10" y="20" width="60" height="160" fill="red"/></svg>')).png().toBuffer();
  const padded = await sharp(Buffer.from('<svg width="400" height="300"><rect x="150" y="40" width="60" height="160" fill="red"/></svg>')).png().toBuffer();
  const pose: FacePose = { mouth: [30, 40, 20, 10], eyes: [[25, 30, 8, 5]], lips: [35,44,10,2], atlas: 'head' };
  const mapped = await registerRigFace(pose, source, padded, 0.5);
  expect(mapped.mouth).toEqual([340, 120, 40, 20]);
  expect(mapped.eyes[0]).toEqual([330, 100, 16, 10]);
  expect(mapped.lips).toEqual([350,128,20,4]);
  expect(offsetFace(mapped,0,12).lips).toEqual([350,140,20,4]);
  expect(offsetFace(mapped, 0, 12).mouth[1]).toBe(132);
});

test('static patches are rejected even when the vision response approves an atlas', async () => {
  mocks.paint.mockResolvedValue(await sharp({create:{width:192,height:192,channels:4,background:'#aabbcc'}}).png().toBuffer());
  await expect(prepareFace(files, 'hero')).rejects.toThrow(/patches are static/);
  expect(registeredFace(files, 'hero')).toBeUndefined();
});

test('3D view registrations are cached independently and a repainted profile does not disable the other faces', async()=>{
  const image=await draw();
  files.write(files.path('cast/hero/model/model.json'),{glb:'model.glb',views:{front:{image:'front.png'},left:{image:'left.png'},right:{image:'right.png'}}});
  for(const view of ['front','left','right'])files.write(files.path('cast/hero/model',view+'.png'),image);
  await prepareFace(files,'hero');
  expect(mocks.paint).toHaveBeenCalledTimes(5);
  const before=registeredFace(files,'hero')!.info;
  expect(before.sheets['model:front.png'][0]?.lips).toBeDefined();
  files.write(files.path('cast/hero/model/left.png'),await draw('#882233'));
  const stale=registeredFace(files,'hero')!.info;
  expect(stale.sheets['model:left.png']).toBeUndefined();expect(stale.sheets['model:front.png']).toEqual(before.sheets['model:front.png']);expect(stale.imagePose).toEqual(before.imagePose);
  await prepareFace(files,'hero');expect(mocks.paint).toHaveBeenCalledTimes(6);
});

test('uncertain source lips keep the candidate for review and a retry reuses the paid atlas', async()=>{
  const vision=mocks.vision.getMockImplementation()!;
  mocks.vision.mockImplementation(async(...args)=>{
    const ask=args[1] as {label:string;images:Buffer[]};
    return ask.label.startsWith('face-source:')?{box:[0.2,0.4,0.5,0.12],confidence:0.5}:vision(...args);
  });
  await expect(prepareFace(files,'hero')).rejects.toThrow(/Lip corners/);
  expect(registeredFace(files,'hero')).toBeUndefined();expect(registeredFace(files,'hero','face-candidate.json')?.info.imagePose).toBeDefined();expect(mocks.paint).toHaveBeenCalledTimes(1);
  mocks.vision.mockImplementation(vision);await prepareFace(files,'hero');
  expect(mocks.paint).toHaveBeenCalledTimes(2);expect(registeredFace(files,'hero')?.info.imagePose?.lips).toBeDefined();expect(fs.existsSync(files.path('cast/hero/face-candidate.json'))).toBe(false);
});


test('large generated head crops are composited at source resolution before reducing mouth patches', async()=>{
  const atlas=await mocks.paint.getMockImplementation()!();
  mocks.paint.mockResolvedValue(await sharp(atlas).resize(1536,1536).png().toBuffer());
  await prepareFace(files,'hero');
  const info=registeredFace(files,'hero')!.info,view=info.imagePose!.atlas!;
  expect(info.atlases![view].X[2]).toBe(128);
  expect(info.frames![view].D.every(v=>v>=0&&v<=1)).toBe(true);
});


test('each talk pose is located separately and mapped from its own trimmed silhouette', async()=>{
  const sheet=await sharp(Buffer.from('<svg width="256" height="256"><rect x="16" y="8" width="64" height="240" fill="#6495ed"/><rect x="176" y="8" width="64" height="240" fill="#6495ed"/><circle cx="48" cy="20" r="8" fill="red"/><circle cx="208" cy="20" r="8" fill="red"/></svg>')).png().toBuffer();
  files.write(files.path('cast/hero/sprites/talk.png'),sheet);
  files.write(files.path('cast/hero/sprites/sprites.json'),{cols:2,rows:1,talk:{front:{sheet:'talk.png',gestures:['listen','nod']}}});
  const vision=mocks.vision.getMockImplementation()!;
  mocks.vision.mockImplementation(async(...args)=>{
    const ask=args[1] as {label:string;images:Buffer[]};
    if(ask.label.includes(':cell:')){
      const pixels=await sharp(ask.images[0]).removeAlpha().raw().toBuffer();let red=0;
      for(let i=0;i<pixels.length;i+=3)if(pixels[i]>pixels[i+1]+80&&pixels[i]>pixels[i+2]+80)red++;
      expect(red).toBeGreaterThan(20);
    }
    return vision(...args);
  });
  await prepareFace(files,'hero');
  const poses=registeredFace(files,'hero')!.info.sheets['talk.png'];
  expect(poses[1]!.mouth[0]-poses[0]!.mouth[0]).toBeCloseTo(32);
  expect(poses[1]!.lips![0]-poses[0]!.lips![0]).toBeCloseTo(32);
  const calls=mocks.vision.mock.calls.filter(([,ask])=>ask.label.includes(':cell:'));
  expect(calls).toHaveLength(2);expect(calls.every(([,ask])=>ask.images.length===1)).toBe(true);
});

test('mouth crops beyond a generated cell stay transparent instead of painting a grey square onto the beard', async()=>{
  const vision=mocks.vision.getMockImplementation()!;
  mocks.vision.mockImplementation(async(...args)=>{
    const ask=args[1] as {label:string};
    return ask.label.startsWith('face-atlas-lip:')?{box:[.85,.85,.1,.1],confidence:.95}:vision(...args);
  });
  await prepareFace(files,'hero');
  const info=registeredFace(files,'hero')!.info,view=info.imagePose!.atlas!,[left,top,width,height]=info.atlases![view].X;
  const pixel=await sharp(files.path('cast','hero',info.image)).extract({left:left+width-1,top:top+height-1,width:1,height:1}).ensureAlpha().raw().toBuffer();
  expect(pixel[3]).toBe(0);
});
