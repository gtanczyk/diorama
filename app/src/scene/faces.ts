// Locate faces, paint their reusable articulations and bind them to unchanged source graphics.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { askSparkJson } from '../meta/spark.ts';
import { museEdit } from '../meta/muse.ts';
import { Rig, swingPose } from '../play/rig.ts';
import { MOUTHS, offsetFace, type Box, type FaceDefinition, type FacePose, type Mouth } from '../play/lipsync.ts';
import { registeredFace, sha256, faceSourceHash, rigFingerprint } from './faces-data.ts';
import { alphaBounds, registerRigFace } from './face-registration.ts';
import type { WorldFiles } from '../world/files.ts';

const Rect = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().positive().max(1), z.number().positive().max(1)]);
const Located = z.object({ head: Rect, mouth: Rect, eyes: z.array(Rect).max(2), confidence: z.number().min(0).max(1) });
const LocatedGrid = z.object({ poses: z.array(Located.nullable()), matches: z.boolean(), articulation: z.boolean(), reason: z.string() });
type Located = z.infer<typeof Located>;
const FACE_VERSION = 'lip-square-v3';
const SPRITE_VERSION = 'individual-alpha-heads-v5';
type Grid = { cols: number; rows: number; count: number };
const validBox = ([x, y, w, h]: Box) => x + w <= 1.005 && y + h <= 1.005;
export const pixels = ([x, y, w, h]: Box, width: number, height: number): Box => [x * width, y * height, w * width, h * height];

async function locate(files: WorldFiles, key: string, image: Buffer, grid: Grid, reference?: Buffer): Promise<Array<Located | null>> {
  if (!reference && grid.count > 1) {
    const meta=await sharp(image).metadata(),cw=meta.width!/grid.cols,ch=meta.height!/grid.rows,poses:Array<Located|null>=[];
    for(let first=0;first<grid.count;first+=3)await Promise.all(Array.from({length:Math.min(3,grid.count-first)},async(_,n)=>{
      const i=first+n,cell=await sharp(image).extract(cropRect([i%grid.cols*cw,Math.floor(i/grid.cols)*ch,cw,ch],meta.width!,meta.height!)).png().toBuffer();
      const box=await alphaBounds(cell);
      box[3]=Math.min(box[3],Math.max(box[2]*0.9,box[3]*0.38));
      const rect=cropRect(box,Math.floor(cw),Math.floor(ch));
      const crop=await sharp(cell).extract(rect).resize(512,512,{fit:'fill'}).png().toBuffer();
      const found=(await locate(files,`${key}:cell:${i}`,crop,{cols:1,rows:1,count:1}))[0];
      const map=([x,y,w,h]:Box):Box=>[(rect.left+x*rect.width)/cw,(rect.top+y*rect.height)/ch,w*rect.width/cw,h*rect.height/ch];
      poses[i]=found?{...found,head:map(found.head),mouth:map(found.mouth),eyes:found.eyes.map(map)}:null;
    }));
    return poses;
  }
  let prompt = `Locate the visible faces of this painted game character. Image 1 is a ${grid.cols} column by ${grid.rows} row sprite grid; inspect the first ${grid.count} cells in row-major order. ${reference ? 'Image 2 is the identity reference. Verify the generated heads keep its same identity, view direction and painted style, and that cells show in order: relaxed closed; pressed M/B/P; slightly open with teeth; EH open; AH wide; OH round; OO puckered; F/V upper teeth on lower lip; L tongue raised. articulation is true only if all nine requested shapes are distinguishable and in order.' : 'matches and articulation should be true; no atlas validation is required.'}
Return one pose per inspected cell (null if back-facing, face obscured, unrecognizable or no visible mouth). All rectangles are [x,y,width,height] normalized 0..1 RELATIVE TO THAT CELL, never to the whole sheet. head: the entire head including hat/hair, excluding neck and torso. mouth: a reusable LOWER-FACE PATCH, not a tight bounding box around the lip opening: include the moustache/skin just below the nose, both lips and the upper chin/beard, but do not cross the face silhouette. Keep this same anatomical region for every articulation even when lips are closed. eyes: up to two small rectangles including the eye, its upper lid/brow and surrounding skin; centre each rectangle on the eye. confidence: precision of these locations. Do not invent a face for a head seen from behind. Give a short reason, especially when a face or requested articulation is invalid.
Reply JSON only: {poses:[{head:[...],mouth:[...],eyes:[[...]],confidence:0.9}|null,...],matches:true,articulation:true,reason:"..."}.`;
  let images = [image];
  if (grid.count > 1 || reference) {
    const meta = await sharp(image).metadata(), cw = meta.width! / grid.cols, ch = meta.height! / grid.rows;
    images = await Promise.all(Array.from({ length: grid.count }, (_, i) => sharp(image).extract(cropRect([(i % grid.cols) * cw, Math.floor(i / grid.cols) * ch, cw, ch], meta.width!, meta.height!))
      .resize({ width: 512, height: 512, fit: 'inside' }).png().toBuffer()));
    prompt = `Inspect the first ${grid.count} images. EACH IMAGE IS ONE SEPARATE FRAME of the same painted character, with its own coordinates. Return exactly ${grid.count} poses in image order. Every box is [x,y,width,height], normalized 0..1 relative to that individual image. There is NO sprite grid in these input images. A back-facing, obscured or absent face is null. head includes the hat/hair but excludes neck and torso. mouth is the same anatomical LOWER-FACE region in each image: below the nose through the lips and upper chin/beard, including some surrounding skin; never a tight box around an opening. eyes are small regions centred on each eye, including lids/brow and surrounding skin. Confidence must reflect location precision. ${reference ? `The LAST image is only an identity reference. Check identity, view and painted style match it. The first nine images must respectively show relaxed closed, pressed M/B/P, almost-closed teeth, open EH, wide AH, round OH, puckered OO, teeth-on-lower-lip F/V, tongue-raised L. matches/articulation are true only when these checks pass.` : 'matches and articulation should be true; no atlas validation is needed.'} Reply JSON only: {poses:[{head:[...],mouth:[...],eyes:[[...]],confidence:0.95}|null,...],matches:true,articulation:true,reason:"..."}.`;
  }
  const result = LocatedGrid.parse(await askSparkJson(files.memo, { schema: LocatedGrid, label: `face-locate:${key}`, prompt, images: [...images, ...(reference ? [reference] : [])], personal: true }));
  if (result.poses.length !== grid.count) throw new Error(`face locator returned ${result.poses.length} poses, expected ${grid.count}`);
  if (reference && (!result.matches || !result.articulation)) throw new Error(`face atlas rejected: ${result.reason}`);
  return result.poses.map(p => p && p.confidence >= 0.6 && [p.head, p.mouth, ...p.eyes].every(validBox) ? p : null);
}

function cropRect(box: Box, width: number, height: number) {
  const [x, y, w, h] = box;
  const left = Math.max(0, Math.floor(x + 1e-7)), top = Math.max(0, Math.floor(y + 1e-7));
  return { left, top, width: Math.max(1, Math.min(width - left, Math.ceil(x + w - 1e-7) - left)), height: Math.max(1, Math.min(height - top, Math.ceil(y + h - 1e-7) - top)) };
}

/** Register the actual lip corners, rather than stretching an invented lower face over the beard. */
async function calibrateLips(files: WorldFiles, key: string, data: Buffer, grid: Grid, poses: Array<FacePose | null>): Promise<boolean> {
  const pending = poses.map((pose,i)=>({pose,i})).filter(p=>p.pose&&!p.pose.lips) as Array<{pose:FacePose;i:number}>;
  if (!pending.length) return false;
  const meta = await sharp(data).metadata(), cw=meta.width!/grid.cols, ch=meta.height!/grid.rows;
  const schema=z.object({box:Rect,confidence:z.number().min(0).max(1),open:z.boolean().optional()});
  const failures:string[]=[];
  for(let n=0;n<pending.length;n+=3){const batch=await Promise.allSettled(pending.slice(n,n+3).map(async({pose,i})=>{
    const [mx,my,mw,mh]=pose.mouth;
    const cellLeft=i%grid.cols*cw,cellTop=Math.floor(i/grid.cols)*ch;
    const local=cropRect([mx-mw*0.75,my-mh*1.25,mw*2.5,mh*2.75],Math.floor(cw),Math.floor(ch));
    const rect={...local,left:local.left+cellLeft,top:local.top+cellTop};
    const image=await sharp(data).extract(rect).resize(512,512,{fit:'fill'}).png().toBuffer();
    const result=schema.parse(await askSparkJson(files.memo,{schema,label:`face-source:${key}:${i}`,images:[image],personal:true,
      prompt:'This is ONE close-up of the original painted character mouth. Locate a tight box around the actual upper and lower lips and both mouth corners. A closed mouth has a thin lip line; do not include moustache, beard, nose, chin or surrounding skin. Return normalized [x,y,width,height] relative to this ONE entire image. The horizontal centre and upper lip edge must be precise for animation. Also return open:true only when the original mouth has a visible open cavity, otherwise open:false. JSON only: {"box":[0.3,0.25,0.5,0.2],"confidence":0.95}.'}));
    if(typeof result.open==='boolean')pose.sourceOpen=result.open;
    const[x,y,w,h]=result.box;
    const box:Box=[rect.left-i%grid.cols*cw+x*rect.width,rect.top-Math.floor(i/grid.cols)*ch+y*rect.height,w*rect.width,h*rect.height];
    if(result.confidence<0.7||!validBox(result.box)){
      pose.suggestedLips=box;pose.lipConfidence=result.confidence;
      throw new Error(`Lip corners of pose ${i} need review (${Math.round(result.confidence*100)}% confidence)`);
    }
    pose.lips=box;delete pose.suggestedLips;delete pose.lipConfidence;
  }));for(const result of batch)if(result.status==='rejected')failures.push(String(result.reason instanceof Error?result.reason.message:result.reason));}
  if(failures.length)throw new Error(failures.join('; '));
  return true;
}

/** Individual frames can drift even when a grid keeps the same head size. Align lip centres and upper rims. */
async function calibrateFrames(files: WorldFiles, key: string, info: FaceDefinition, atlas: Buffer): Promise<boolean> {
  info.frames ??= {};
  const views = [...new Set([info.imagePose?.atlas ?? 'default', ...Object.values(info.sheets).flatMap(poses => poses.filter(Boolean).map(p => p!.atlas ?? 'default'))])];
  let changed = false;
  const schema = z.object({ box: Rect, confidence: z.number().min(0).max(1) });
  const meta = await sharp(atlas).metadata();
  for (const view of views) {
    if (info.frames[view]) continue;
    const mouths = view === 'default' ? info.mouths : info.atlases?.[view];
    if (!mouths) continue;
    const frames = {} as Record<Mouth, Box>;
    for (let i = 0; i < MOUTHS.length; i += 3) await Promise.all(MOUTHS.slice(i,i+3).map(async mouth => {
      const image = await sharp(atlas).extract(cropRect(mouths[mouth], meta.width!, meta.height!)).resize(512,512,{fit:'fill'}).png().toBuffer();
      const result = schema.parse(await askSparkJson(files.memo, { schema, label:`face-frame:${key}:${view}:${mouth}`, images:[image], personal:true,
        prompt:'This image is one close-up of a painted mouth. Locate a tight rectangle around the actual lips and the mouth opening, including both corners. Exclude beard, moustache and nose. For an open mouth include the lip rim around the dark cavity. Return normalized [x,y,width,height] relative to this one entire image. Pay special attention to the top edge of the upper lip and the horizontal centre of the mouth; they must be aligned to another painting. JSON only: {"box":[0.3,0.25,0.5,0.2],"confidence":0.95}.' }));
      if (result.confidence < 0.7 || !validBox(result.box)) throw new Error(`Mouth frame ${mouth} could not be aligned confidently`);
      frames[mouth] = result.box;
    }));
    info.frames[view] = frames;
    info.sourceVersions ??= {}; info.sourceVersions[`frames:${view}`] = 'patches-v1';
    info.anchors ??= {}; info.anchors[view] = frames.X;
    changed = true;
  }
  return changed;
}

const ATLAS_PROMPT = `The first image is a fixed 3 by 3 grid of nine copies of ONE painted character head. The second image is its identity reference. Create a production lip-sync atlas by changing ONLY the mouth and a small part of the lower jaw in each cell. Preserve the EXACT head size, position, angle, identity, eyes, eyebrows, hat, hair, moustache, beard, lighting, palette and painting texture. Keep the 3x3 layout and all head landmarks perfectly registered. The mouths must actually have these distinct shapes, in row-major order: 1 relaxed CLOSED at rest; 2 CLOSED lips pressed together for M/B/P; 3 slightly open with teeth nearly together; 4 moderately OPEN for EH; 5 conversational OPEN for AH, never shouting; 6 ROUNDED OPEN for OH; 7 small PUCKERED for OO; 8 upper teeth touching lower lip for F/V; 9 slightly open with the tongue raised for L. Keep the original small lip width, thin lip thickness, age and wrinkles. No inflated glossy lips. Conversational movement: open the lips modestly inside the original beard, keep the jaw outline fixed. Natural dark mouth interiors and restrained teeth; no smile unless required by the original character. No text, no labels, no borders, no added objects. Do not repaint the upper face or rotate the head. Keep the background plain and constant.`;

/** One call paints all reusable mouth shapes for one view, independent of the number of voice lines. */
async function mouthPatches(files: WorldFiles, key: string, reference: Buffer, take: number): Promise<{patches:Buffer[];frames:Record<Mouth,Box>}> {
  const square = await sharp(reference).resize(320, 320, { fit: 'contain', background: '#d9d9d9' }).flatten({ background: '#d9d9d9' }).png().toBuffer();
  const template = await sharp({ create: { width: 960, height: 960, channels: 3, background: '#d9d9d9' } }).composite(MOUTHS.map((_, i) => ({ input: square, left: (i % 3) * 320, top: Math.floor(i / 3) * 320 }))).png().toBuffer();
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const atlas = await museEdit(files.memo, { label: `face-atlas:${key}`, images: [template, square], prompt: ATLAS_PROMPT, size: '1024x1024', take: take * 2 + attempt });
      const poses = await locate(files, `${key}:atlas:${take}:${attempt}`, atlas, { cols: 3, rows: 3, count: 9 }, square);
      if (poses.some(p => !p)) throw new Error('a generated mouth is obscured or could not be located confidently');
      const meta = await sharp(atlas).metadata(), width = meta.width!, height = meta.height!;
      // Locate each mouth in its full head. A lower-face crop inferred from a grid can cut a lip off.
      const cells = await Promise.all(MOUTHS.map((_,i)=>sharp(atlas).extract(cropRect([(i%3)*width/3,Math.floor(i/3)*height/3,width/3,height/3],width,height)).png().toBuffer()));
      const schema=z.object({box:Rect,confidence:z.number().min(0).max(1)}), lips:Box[]=[];
      for(let i=0;i<MOUTHS.length;i+=3)await Promise.all(MOUTHS.slice(i,i+3).map(async(m,n)=>{
        const at=i+n, image=await sharp(cells[at]).resize(512,512,{fit:'fill'}).png().toBuffer();
        const result=schema.parse(await askSparkJson(files.memo,{schema,label:`face-atlas-lip:${key}:${m}`,images:[image],personal:true,
          prompt:'This image contains ONE painted character head. Locate the actual lips and mouth opening only, from corner to corner, including the upper/lower lip rim. Exclude moustache, beard, nose and chin. For a closed mouth locate its thin lip line. Return normalized [x,y,width,height] relative to this ONE full image, and confidence. JSON only: {"box":[0.3,0.6,0.25,0.08],"confidence":0.95}.'}));
        if(result.confidence<0.7||!validBox(result.box))throw new Error(`Generated lip frame ${m} could not be located confidently`);
        lips[at]=result.box;
      }));
      const dimensions=await Promise.all(cells.map(c=>sharp(c).metadata()));
      const neutralWidth=lips[0][2]*dimensions[0].width!, side=Math.ceil(neutralWidth*2.2);
      const frames={} as Record<Mouth,Box>;
      const patches=await Promise.all(cells.map(async(cell,i)=>{
        const w=dimensions[i].width!,h=dimensions[i].height!,[lx,ly,lw,lh]=pixels(lips[i],w,h);
        const left=Math.round(lx+lw/2-side/2),top=Math.round(ly-neutralWidth*0.35);
        const rect=cropRect([left,top,side,side],w,h);
        const part=await sharp(cell).extract(rect).png().toBuffer();
        frames[MOUTHS[i]]=[(lx-left)/side,(ly-top)/side,lw/side,lh/side];
        const composite=await sharp({create:{width:side,height:side,channels:4,background:'#0000'}}).composite([{input:part,left:rect.left-left,top:rect.top-top}]).png().toBuffer();
        return sharp(composite).resize(128,128).png().toBuffer();
      }));
      const raw = await Promise.all([patches[0], patches[4]].map(p => sharp(p).removeAlpha().raw().toBuffer()));
      const difference = raw[0].reduce((sum, value, i) => sum + Math.abs(value - raw[1][i]), 0) / raw[0].length;
      if (difference < 3) throw new Error('mouth patches are static; atlas registration may have selected another part of the head');
      return {patches,frames};
    } catch (e) { failure = e; console.log(`${key}: ${String(e instanceof Error ? e.message : e)}; ${attempt ? 'keeping the previous face' : 'trying one more atlas'}`); }
  }
  throw failure;
}

export async function prepareFace(files: WorldFiles, key: string, options: { take?: number; force?: boolean; imageOnly?: boolean } = {}) {
  if (!/^[a-z0-9][\w-]*$/.test(key)) throw new Error('Invalid character key');
  const source = files.path('cast', `${key}.png`), dir = files.path('cast', key);
  if (!fs.existsSync(source)) throw new Error(`${key}: no painted figure`);
  const candidate = registeredFace(files,key,'face-candidate.json');
  const old = candidate?.info ?? registeredFace(files, key)?.info;
  const info: FaceDefinition = old ? structuredClone(old) : { image: '', mouths: {} as Record<Mouth, Box>, sheets: {}, atlases: {}, sheetHashes: {}, seed: parseInt(sha256(key).slice(0, 6), 16) / 1000 };
  info.atlases ??= {}; info.sheetHashes ??= {}; info.sourceVersions ??= {};
  const layers: sharp.OverlayOptions[] = [];
  let width = 1152, height = 0;
  if (old) {
    const buffer = fs.readFileSync(path.join(dir, old.image)), meta = await sharp(buffer).metadata();
    width = Math.max(width, meta.width!); height = meta.height!;
    layers.push({ input: buffer, left: 0, top: 0 });
  }
  let changed = !!candidate;
  const skipped: string[] = [];
  const atlasNow = () => sharp({ create: { width, height, channels: 4, background: '#0000' } }).composite(layers).png().toBuffer();
  const checkpoint = async () => {
    if (!changed) return;
    const atlas = await atlasNow(), image = `face-candidate-${sha256(atlas).slice(0,12)}.png`;
    files.write(path.join(dir,image),atlas);
    files.write(path.join(dir,'face-candidate.json'),{...info,image});
  };
  const align = async (name:string,data:Buffer,grid:Grid,poses:Array<FacePose|null>) => {
    try{return await calibrateLips(files,name,data,grid,poses);}
    catch(error){changed=true;await checkpoint();throw error;}
  };
  const make = async (name: string, data: Buffer, grid: Grid) => {
    const located = await locate(files, `${key}:${name}`, data, grid);
    const first = located.findIndex(p => !!p);
    if (first < 0) { skipped.push(`${name}: no visible face/mouth`); return; }
    const meta = await sharp(data).metadata(), cw = meta.width! / grid.cols, ch = meta.height! / grid.rows;
    const head = pixels(located[first]!.head, cw, ch);
    head[0] += (first % grid.cols) * cw; head[1] += Math.floor(first / grid.cols) * ch;
    const reference = await sharp(data).extract(cropRect(head, meta.width!, meta.height!)).png().toBuffer();
    const {patches,frames} = await mouthPatches(files, `${key}:${name}`, reference, options.take ?? 0);
    const atlas = `${name}:${sha256(data).slice(0, 10)}:${options.take ?? 0}`;
    const mouths = {} as Record<Mouth, Box>;
    patches.forEach((patch, i) => { layers.push({ input: patch, left: i * 128, top: height }); mouths[MOUTHS[i]] = [i * 128, height, 128, 128]; });
    height += 128;
    if (!Object.keys(info.mouths).length) info.mouths = mouths;
    info.atlases![atlas] = mouths;
    // Re-locate the final cropped patches: full-head detections are only crop proposals.
    // A small error near a profile edge otherwise turns the crop background into a lip patch.
    info.anchors ??= {}; info.anchors[atlas]=frames.X;
    changed = true;
    const previous = name === 'image' ? [info.imagePose] : info.sheets[name];
    const sameSource = name === 'image' ? info.imageHash === sha256(data) : info.sheetHashes![name] === faceSourceHash(files,key,name);
    return located.map((pose,i): FacePose | null => pose ? { mouth: pixels(pose.mouth, cw, ch), eyes: pose.eyes.map(e => pixels(e, cw, ch)), atlas,
      ...(sameSource && previous?.[i]?.lips ? {lips:previous[i]!.lips,sourceOpen:previous[i]!.sourceOpen} : {}) } : null);
  };
  const image = fs.readFileSync(source), hash = sha256(image);
  if (!info.imagePose || info.imageHash !== hash || (info.imagePose.atlas?.startsWith('image:') && info.sourceVersions.image !== FACE_VERSION) || options.force) {
    console.log(`${key}: locating the painted face and preparing its mouth shapes`);
    const poses = await make('image', image, { cols: 1, rows: 1, count: 1 });
    if (poses?.[0]) { info.imagePose = poses[0]; info.imageHash = hash; info.sourceVersions.image = FACE_VERSION; }
  }
  await checkpoint();
  if(info.imagePose?.atlas!=='default' && info.sourceVersions['lips:image']!=='context-v2-fill' && !info.sourceVersions['lips:image']?.startsWith('reviewed:') && info.imagePose)delete info.imagePose.lips;
  if (info.imagePose && !info.imagePose.lips) changed = await align(`${key}:image`, image, { cols:1, rows:1, count:1 }, [info.imagePose]) || changed;
  if(info.imagePose?.lips && info.imagePose.atlas!=='default' && !info.sourceVersions['lips:image']?.startsWith('reviewed:'))info.sourceVersions['lips:image']='context-v2-fill';
  await checkpoint();
  const rigFile = path.join(dir, 'rig.json');
  if (info.imagePose && fs.existsSync(rigFile)) {
    const rig = Rig.parse(files.readJson(rigFile));
    if (rig.sheet && fs.existsSync(path.join(dir, rig.sheet.file))) {
      const [cw, ch] = rig.sheet.cell, i = rig.sheet.frames;
      const standing = await sharp(path.join(dir, rig.sheet.file)).extract({ left: (i % rig.sheet.cols) * cw, top: Math.floor(i / rig.sheet.cols) * ch, width: cw, height: ch }).png().toBuffer();
      const base = await registerRigFace(info.imagePose, image, standing, rig.sheet.scale);
      const name = `rig:${rig.sheet.file}`, hash = faceSourceHash(files, key, name);
      if (info.sheetHashes[name] !== hash || info.sheets[name]?.[0]?.atlas !== base.atlas || JSON.stringify(info.sheets[name]?.at(-1)?.lips) !== JSON.stringify(base.lips) || options.force) {
        info.sheets[name] = [...Array(rig.sheet.frames).keys()].map(i => {
          const torso = swingPose(rig, i / rig.sheet!.frames).torso;
          return offsetFace(base, torso.to[0] - torso.from[0], torso.to[1] - torso.from[1]);
        }).concat([base]);
        info.sheetHashes[name] = hash; changed = true;
      }
    } else if (rig.parts.length) {
      const fingerprint = rigFingerprint(files, key);
      if (info.rigHash !== fingerprint || !info.rigPose?.lips || options.force) {
        const standing = await sharp({ create: { width: rig.size[0], height: rig.size[1], channels: 4, background: '#0000' } })
          .composite(rig.parts.map(part => ({ input: path.join(dir, part.file), left: part.at[0], top: part.at[1] }))).png().toBuffer();
        info.rigPose = await registerRigFace(info.imagePose, image, standing);
        info.rigHash = fingerprint; changed = true;
      }
    }
  }
  const spritesFile = path.join(dir, 'sprites', 'sprites.json');
  if (!options.imageOnly && fs.existsSync(spritesFile)) {
    const sprites = files.readJson(spritesFile) as { cols: number; rows: number; talk?: Record<string, { sheet: string; gestures?: string[] }> };
    for (const view of Object.values(sprites.talk ?? {})) {
      const file = path.join(dir, 'sprites', view.sheet);
      if (!fs.existsSync(file)) continue;
      const data = fs.readFileSync(file), hash = sha256(data);
      if (info.sheetHashes[view.sheet] === hash && info.sheets[view.sheet]?.some(Boolean) && (!info.sheets[view.sheet]?.some(p => p?.atlas && p.atlas !== 'default') || info.sourceVersions[view.sheet] === SPRITE_VERSION) && !options.force) continue;
      console.log(`${key}: preparing facial animation for ${view.sheet}`);
      const poses = await make(view.sheet, data, { cols: sprites.cols, rows: sprites.rows, count: view.gestures?.length ?? sprites.cols * sprites.rows });
      if (poses) { info.sheets[view.sheet] = poses; info.sheetHashes[view.sheet] = hash; info.sourceVersions[view.sheet] = SPRITE_VERSION; await checkpoint(); }
    }
  }
  if (!options.imageOnly && fs.existsSync(spritesFile)) {
    const sprites = files.readJson(spritesFile) as { cols: number; rows: number };
    for (const [name, poses] of Object.entries(info.sheets).filter(([name]) => !name.startsWith('rig:') && !name.startsWith('model:'))) {
      if (poses.some(p => p && !p.lips)) changed = await align(`${key}:${name}`, fs.readFileSync(path.join(dir, 'sprites', name)), { cols:sprites.cols, rows:sprites.rows, count:poses.length }, poses) || changed;
    }
  }
  const modelFile = path.join(dir, 'model', 'model.json');
  if (!options.imageOnly && fs.existsSync(modelFile)) {
    const model = files.readJson(modelFile) as { texture?: string; views: Record<string, { image: string }> };
    // Projected paint on a real mesh can articulate without remeshing a reconstructed closed mouth.
    if (model.texture !== 'model') for (const [view, entry] of Object.entries(model.views).filter(([view]) => view !== 'back')) {
      const name = `model:${entry.image}`, source = path.join(dir, 'model', entry.image);
      if (!fs.existsSync(source)) continue;
      const hash = faceSourceHash(files,key,name);
      if (info.sheetHashes[name] !== hash || !info.sheets[name]?.some(Boolean) || info.sourceVersions[name] !== FACE_VERSION || options.force) {
        console.log(`${key}: preparing the 3D ${view} facial surface`);
        const poses = await make(name, fs.readFileSync(source), {cols:1,rows:1,count:1});
        if (poses) { info.sheets[name]=poses; info.sheetHashes[name]=hash; info.sourceVersions[name]=FACE_VERSION; await checkpoint(); }
      }
      const poses = info.sheets[name];
      if (info.sourceVersions[`lips:${name}`] !== 'context-v2-fill' && !info.sourceVersions[`lips:${name}`]?.startsWith('reviewed:')) for (const p of poses ?? []) if(p) delete p.lips;
      if (poses?.some(p=>p&&!p.lips)) { changed = await align(`${key}:${name}`,fs.readFileSync(source),{cols:1,rows:1,count:1},poses) || changed; info.sourceVersions[`lips:${name}`]='context-v2-fill'; }
    }
  }
  await checkpoint();
  changed = await calibrateFrames(files, key, info, await atlasNow()) || changed;
  if (changed) {
    const atlas = await sharp({ create: { width, height, channels: 4, background: '#0000' } }).composite(layers).png().toBuffer();
    info.image = `face-atlas-${sha256(atlas).slice(0, 12)}.png`;
    files.write(path.join(dir, info.image), atlas);
    files.write(path.join(dir, 'face.json.tmp'), info);
    fs.renameSync(path.join(dir, 'face.json.tmp'), path.join(dir, 'face.json'));
  }
  fs.rmSync(path.join(dir,'face-candidate.json'),{force:true});
  const status = { take: options.take ?? 0, at: new Date().toISOString(), state: info.imagePose || Object.keys(info.sheets).length ? 'ready' : 'unsupported', skipped };
  files.write(path.join(dir, 'face-attempt.json'), status);
  console.log(`${key}: ${changed ? 'face prepared' : 'face unchanged'} · image ${!!info.imagePose} · ${Object.keys(info.sheets).length} registered sheets${skipped.length ? ` · ${skipped.join('; ')}` : ''}`);
  return { ...status, changed };
}
