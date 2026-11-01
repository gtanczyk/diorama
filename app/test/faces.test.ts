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
  mocks.vision.mockImplementation(async (_memo, ask) => ask.label.startsWith('face-atlas-lips:') ? atlasLips(_memo, ask) : (ask.label.startsWith('face-frame:') || ask.label.startsWith('face-source:') || ask.label.startsWith('face-atlas-lip:')) ? {box:[0.2,0.4,0.5,0.12],confidence:0.95} : ask.label.startsWith('face-lips:') ? { lips: ask.images.map(() => ({box:[0.2,0.4,0.5,0.12],confidence:0.95})) } : ({ poses: Array.from({ length: ask.images.length > 1 ? 9 : 1 }, () => face), matches: true, articulation: true, reason: 'Visible face' }));
  const layers = await Promise.all(Array.from({length:9}, async (_,i) => ({input: await sharp({create:{width:64,height:64,channels:4,background:{r:30+i*20,g:50+i*15,b:70+i*10,alpha:1}}}).png().toBuffer(),left:i%3*64,top:Math.floor(i/3)*64})));
  mocks.paint.mockResolvedValue(await sharp({ create: { width: 192, height: 192, channels: 4, background: '#aabbcc' } }).composite(layers).png().toBuffer());
  const image = await draw();
  files.write(files.path('cast/hero.png'), image);
  files.write(files.path('cast/hero/sprites/talk.png'), image);
  files.write(files.path('cast/hero/sprites/sprites.json'), { cols: 1, rows: 1, talk: { front: { sheet: 'talk.png', gestures: ['listen'] } } });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
/** The one ask for every mouth answers as the per-mouth asks a test sets up would, mouth by mouth. */
async function atlasLips(memo: unknown, ask: { label: string; images: Buffer[] }) {
  const parts = ask.label.split(':'), mouths = [...parts.pop()!], key = parts.slice(1).join(':');
  const each = mocks.vision.getMockImplementation()!;
  return { lips: await Promise.all(mouths.map((m, i) => each(memo, { ...ask, label: `face-atlas-lip:${key}:${m}`, images: [ask.images[i]] }))) };
}

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

test('every generated mouth is located in one ask, not one ask per mouth', async () => {
  await prepareFace(files, 'hero', { imageOnly: true });
  const labels = mocks.vision.mock.calls.map(([, ask]) => ask.label as string);
  expect(labels.filter((l) => l.startsWith('face-atlas-lips:'))).toHaveLength(1);
  expect(labels.filter((l) => l.startsWith('face-atlas-lip:'))).toHaveLength(0);
  expect(registeredFace(files, 'hero')?.info.imagePose).toBeDefined();
});

test('a rejected generated atlas never replaces an existing face', async () => {
  await prepareFace(files, 'hero');
  const before = fs.readFileSync(files.path('cast/hero/face.json'));
  mocks.vision.mockImplementation(async (_memo, ask) => ask.label.startsWith('face-atlas-lips:') ? atlasLips(_memo, ask) : (ask.label.startsWith('face-frame:') || ask.label.startsWith('face-source:') || ask.label.startsWith('face-atlas-lip:')) ? {box:[0.2,0.4,0.5,0.12],confidence:0.95} : ask.label.startsWith('face-lips:') ? { lips: ask.images.map(() => ({box:[0.2,0.4,0.5,0.12],confidence:0.95})) } : ({ poses: Array.from({ length: ask.images.length > 1 ? 9 : 1 }, () => face), matches: true, articulation: ask.images.length === 1, reason: 'Mouth shapes identical' }));
  await expect(prepareFace(files, 'hero', { force: true, take: 1 })).rejects.toThrow(/atlas rejected/);
  expect(fs.readFileSync(files.path('cast/hero/face.json')).equals(before)).toBe(true);
  expect(mocks.paint.mock.calls.at(-1)![1].prompt).toContain('Mouth shapes identical');
});

test.each([{ invalidFrames: [7] }, { invalidFrames: [5, 7] }, { invalidFrames: [4, 5, 7] }])('repairs only rejected mouth cells $invalidFrames then revalidates the complete atlas', async ({ invalidFrames }) => {
  const vision = mocks.vision.getMockImplementation()!, original = await mocks.paint.getMockImplementation()!();
  let validations = 0;
  mocks.vision.mockImplementation(async (...args) => {
    const ask = args[1];
    const found = await vision(...args);
    if (ask.label.includes(':atlas:')) {
      validations++;
      if (validations === 1) return { ...found, articulation: false, invalidFrames, reason: 'F/V has an open grin; OH must be round.' };
      // The entire atlas is checked again, not just the replacement mouth.
      expect(ask.images).toHaveLength(10);
    }
    return found;
  });
  const fixed = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#bd4858' } }).png().toBuffer();
  mocks.paint.mockImplementation(async (_memo, ask) => ask.label.startsWith('face-repair:') ? fixed : original);
  await prepareFace(files, 'hero', { imageOnly: true });
  expect(validations).toBe(2);
  expect(mocks.paint).toHaveBeenCalledTimes(1 + invalidFrames.length);
  const calls = mocks.paint.mock.calls.slice(1);
  for (const [i, [, ask]] of calls.entries()) {
    expect(ask.prompt).toContain('F/V has an open grin');
    const index = invalidFrames[i];
    const expected = await sharp(original).extract({ left: index % 3 * 64, top: Math.floor(index / 3) * 64, width: 64, height: 64 }).raw().toBuffer();
    expect(await sharp(ask.images[0]).raw().toBuffer()).toEqual(expected);
  }
  const checks = mocks.vision.mock.calls.filter(([, ask]) => ask.label.includes(':atlas:'));
  for (let i = 0; i < 9; i++) {
    const before = checks[0][1].images[i], after = checks[1][1].images[i];
    expect(after.equals(before)).toBe(!invalidFrames.includes(i));
  }
  expect(registeredFace(files, 'hero')?.info.imagePose).toBeDefined();
});

test('a failed targeted repair stays bounded and never replaces the existing face', async () => {
  await prepareFace(files, 'hero', { imageOnly: true });
  const before = fs.readFileSync(files.path('cast/hero/face.json'));
  const vision = mocks.vision.getMockImplementation()!;
  mocks.paint.mockClear();
  mocks.vision.mockImplementation(async (...args) => {
    const found = await vision(...args);
    return args[1].label.includes(':atlas:') ? { ...found, articulation: false, invalidFrames: [3, 7], reason: 'EH and F/V are still a grin' } : found;
  });
  await expect(prepareFace(files, 'hero', { imageOnly: true, force: true, take: 1 })).rejects.toThrow('EH and F/V are still a grin');
  // One atlas and one repair per failing frame, then it stops.
  expect(mocks.paint).toHaveBeenCalledTimes(3);
  expect(fs.readFileSync(files.path('cast/hero/face.json'))).toEqual(before);
});

test('when F/V alone stays a grin after its repair, B stands in for it and the face is made with no more paint', async () => {
  const vision = mocks.vision.getMockImplementation()!;
  mocks.paint.mockClear();
  mocks.vision.mockImplementation(async (...args) => {
    const found = await vision(...args);
    return args[1].label.includes(':atlas:') ? { ...found, articulation: false, invalidFrames: [7], reason: 'F/V is still a grin' } : found;
  });
  await prepareFace(files, 'hero', { imageOnly: true, force: true, take: 2 });
  expect(mocks.paint).toHaveBeenCalledTimes(2);
  expect(registeredFace(files, 'hero')?.info.imagePose).toBeDefined();
});

test.each([.95, .4])('uncertain generated lips are reinspected in a lower-face crop without repainting (confidence %s)', async confidence => {
  const vision = mocks.vision.getMockImplementation()!;
  mocks.vision.mockImplementation(async (...args) => {
    const ask = args[1];
    if (ask.label.startsWith('face-atlas-lip:') && ask.label.endsWith(':X')) return { box: [.4, .2, .1, .03], confidence: .4 };
    if (ask.label.startsWith('face-atlas-lip-detail:')) return { box: [.3, .4, .4, .1], confidence };
    return vision(...args);
  });
  if (confidence >= .7) {
    await prepareFace(files, 'hero', { imageOnly: true });
    expect(mocks.paint).toHaveBeenCalledTimes(1);
    expect(registeredFace(files, 'hero')?.info.imagePose).toBeDefined();
  } else {
    await expect(prepareFace(files, 'hero', { imageOnly: true })).rejects.toThrow('Generated lip frame X');
    expect(registeredFace(files, 'hero')).toBeUndefined();
  }
  expect(mocks.vision.mock.calls.some(([, ask]) => ask.label.startsWith('face-atlas-lip-detail:'))).toBe(true);
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

test('accepted heads and calibrated mouths survive a lip failure; inspected correction resumes without repainting', async () => {
  const { faceWorkList, readFaceWork } = await import('../src/scene/face-work.ts');
  const { calibrateFaceFrame } = await import('../src/scene/faces.ts');
  const vision = mocks.vision.getMockImplementation()!;
  mocks.vision.mockImplementation(async (...args) => {
    if (args[1].label.startsWith('face-atlas-lip') && args[1].label.endsWith(':X')) return { box:[.3,.4,.4,.05], confidence:.4 };
    return vision(...args);
  });
  await expect(prepareFace(files,'hero',{imageOnly:true})).rejects.toThrow('Generated lip frame X');
  const saved = faceWorkList(files,'hero')[0];
  expect(saved).toMatchObject({accepted:true,stage:'lips'});
  expect(readFaceWork(files,'hero',saved.id).lips.A).toBeDefined();
  expect(mocks.paint).toHaveBeenCalledTimes(1);
  const locatedBefore=mocks.vision.mock.calls.filter(([,a])=>a.label.includes(':atlas:')).length;
  const aBefore=mocks.vision.mock.calls.filter(([,a])=>a.label.startsWith('face-atlas-lip:')&&a.label.endsWith(':A')).length;
  calibrateFaceFrame(files,'hero',saved.id,saved.revision,'X',[.2,.4,.5,.12]);
  expect(()=>calibrateFaceFrame(files,'hero',saved.id,saved.revision,'X',[.2,.4,.5,.12])).toThrow(/changed/);
  await prepareFace(files,'hero',{imageOnly:true,repairWorkId:saved.id});
  expect(mocks.paint).toHaveBeenCalledTimes(1);
  expect(mocks.vision.mock.calls.filter(([,a])=>a.label.includes(':atlas:'))).toHaveLength(locatedBefore);
  expect(mocks.vision.mock.calls.filter(([,a])=>a.label.startsWith('face-atlas-lip:')&&a.label.endsWith(':A'))).toHaveLength(aBefore);
  expect(registeredFace(files,'hero')?.info.imagePose?.lips).toBeDefined();
});

test('calibration rejects invalid boxes, missing revisions, unaccepted art and repainted source', async () => {
  const { faceWorkList, readFaceWork, saveFaceWork, workRevision } = await import('../src/scene/face-work.ts');
  const { calibrateFaceFrame } = await import('../src/scene/faces.ts');
  await prepareFace(files,'hero',{imageOnly:true});
  const saved=faceWorkList(files,'hero')[0];
  expect(()=>calibrateFaceFrame(files,'hero',saved.id,'','X',[.2,.4,.5,.12])).toThrow();
  expect(()=>calibrateFaceFrame(files,'hero',saved.id,saved.revision,'X',[.8,.4,.5,.12])).toThrow();
  const work=readFaceWork(files,'hero',saved.id); work.accepted=false;saveFaceWork(files,'hero',work);
  expect(()=>calibrateFaceFrame(files,'hero',saved.id,workRevision(work),'X',[.2,.4,.5,.12])).toThrow(/articulation/);
  files.write(files.path('cast/hero.png'),await draw('#ff00ff'));
  expect(()=>readFaceWork(files,'hero',saved.id)).toThrow(/source changed/);
  expect(faceWorkList(files,'hero')).toEqual([]);
});

test('directed frame repair preserves neighbours and published face until resumed validation succeeds', async () => {
  const { faceWorkList, readFaceWork, faceWorkAtlas } = await import('../src/scene/face-work.ts');
  const { repairFaceFrame } = await import('../src/scene/faces.ts');
  await prepareFace(files,'hero',{imageOnly:true});
  const before=fs.readFileSync(files.path('cast/hero/face.json'));
  const saved=faceWorkList(files,'hero')[0],original=faceWorkAtlas(files,'hero',readFaceWork(files,'hero',saved.id));
  mocks.paint.mockResolvedValue(await sharp({create:{width:64,height:64,channels:4,background:'#ff1122'}}).png().toBuffer());
  const repaired=await repairFaceFrame(files,'hero',saved.id,saved.revision,'G','Raise the lower lip to the upper incisors.');
  const atlas=faceWorkAtlas(files,'hero',repaired);
  for(let i=0;i<9;i++) {
    const rect={left:i%3*64,top:Math.floor(i/3)*64,width:64,height:64};
    const a=await sharp(original).extract(rect).raw().toBuffer(),b=await sharp(atlas).extract(rect).raw().toBuffer();
    expect(a.equals(b)).toBe(i!==7);
  }
  expect(repaired.lips.G).toBeUndefined();expect(repaired.lips.X).toBeDefined();
  expect(fs.readFileSync(files.path('cast/hero/face.json'))).toEqual(before);
  const paints=mocks.paint.mock.calls.length;
  await prepareFace(files,'hero',{imageOnly:true,repairWorkId:saved.id});
  expect(mocks.paint).toHaveBeenCalledTimes(paints);
  expect(fs.readFileSync(files.path('cast/hero/face.json')).equals(before)).toBe(false);
});

test.each(['source','patch'] as const)('inspected %s calibration resolves low confidence without another paid atlas', async kind => {
  const {inspectFaceCalibration,setFaceCalibration}=await import('../src/scene/face-calibration.ts');
  const vision=mocks.vision.getMockImplementation()!;
  mocks.vision.mockImplementation(async(...args)=>{
    const label=args[1].label;
    if(kind==='source'?label.startsWith('face-source:'):label.startsWith('face-frame:')&&label.endsWith(':X'))return {box:[.2,.4,.5,.12],confidence:.4};
    return vision(...args);
  });
  await expect(prepareFace(files,'hero',{imageOnly:true})).rejects.toThrow(kind==='source'?/Lip corners/:/Mouth frame X/);
  const pending=await inspectFaceCalibration(files,'hero');
  const target=pending.pending!.find(p=>p.kind===kind)!;
  const inspected=await inspectFaceCalibration(files,'hero',target);
  expect(inspected.image).toBeDefined();
  await expect(setFaceCalibration(files,'hero',target,inspected.revision,'0'.repeat(64),[.2,.4,.5,.12],false)).rejects.toThrow(/changed/);
  await setFaceCalibration(files,'hero',target,inspected.revision,inspected.imageHash!,[.2,.4,.5,.12],false);
  await prepareFace(files,'hero',{imageOnly:true});
  expect(mocks.paint).toHaveBeenCalledTimes(1);
  expect(registeredFace(files,'hero')?.info.imagePose?.lips).toBeDefined();
});

test('Studio exposes structured targets and requires revision and correction in MCP schemas', async()=>{
  await import('../src/actions/faces.ts');
  const {describeActions}=await import('../src/actions/registry.ts');
  const schemas=describeActions();
  const repair=schemas.find(a=>a.name==='face_frame_repair')!.input;
  expect(repair.required).toEqual(expect.arrayContaining(['slug','key','id','revision','mouth','hint']));
  const calibration=schemas.find(a=>a.name==='face_calibration_set')!.input;
  const target=(calibration.properties as Record<string,{oneOf:unknown[]}>).target;
  expect(target.oneOf).toHaveLength(2);
  expect(target.oneOf[0]).toMatchObject({type:'object',properties:{kind:{const:'source'}},required:['kind','view','pose']});
});
