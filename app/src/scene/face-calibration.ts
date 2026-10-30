// Human/agent-reviewed lip locations are tied to the exact inspected pixels.
import fs from 'node:fs';
import sharp from 'sharp';
import { z } from 'zod';
import type { Box, FacePose } from '../play/lipsync.ts';
import { registeredFace, sha256 } from './faces-data.ts';
import { FaceRevision, LipBox, MouthName } from './face-work.ts';
import type { WorldFiles } from '../world/files.ts';

export const CalibrationTarget = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('source'),view:z.string().min(1),pose:z.number().int().nonnegative()}),
  z.object({kind:z.literal('patch'),view:z.string().min(1),mouth:MouthName}),
]);
type Target = z.infer<typeof CalibrationTarget>;
const Review = z.object({box:LipBox,open:z.boolean()});
export function reviewedLips(files:WorldFiles,key:string,image:Buffer) {
  const file=files.path('cast',key,'lip-reviews',`${sha256(image)}.json`);
  return fs.existsSync(file)?Review.parse(files.readJson(file)):undefined;
}
export function pixelCrop([x,y,w,h]:Box,width:number,height:number) {
  const left=Math.max(0,Math.floor(x+1e-7)),top=Math.max(0,Math.floor(y+1e-7));
  return {left,top,width:Math.max(1,Math.min(width-left,Math.ceil(x+w-1e-7)-left)),height:Math.max(1,Math.min(height-top,Math.ceil(y+h-1e-7)-top))};
}
export async function sourceLipCrop(data:Buffer,cols:number,rows:number,pose:FacePose,index:number) {
  const meta=await sharp(data).metadata(),cw=meta.width!/cols,ch=meta.height!/rows;
  const [mx,my,mw,mh]=pose.mouth;
  const local=pixelCrop([mx-mw*.75,my-mh*1.25,mw*2.5,mh*2.75],Math.floor(cw),Math.floor(ch));
  const rect={...local,left:local.left+index%cols*cw,top:local.top+Math.floor(index/cols)*ch};
  const image=await sharp(data).extract(rect).resize(512,512,{fit:'fill'}).png().toBuffer();
  return {image,rect,cw,ch};
}
export async function inspectFaceCalibration(files:WorldFiles,key:string,target?:Target) {
  const face=registeredFace(files,key,'face-candidate.json');
  if(!face)throw new Error('No current face candidate; prepare or inspect saved atlas work first');
  const info=face.info, manifest=files.path('cast',key,'face-candidate.json');
  const revision=sha256(fs.readFileSync(manifest));
  const sources:Target[]=[];
  if(info.imagePose&&!info.imagePose.lips)sources.push({kind:'source',view:'image',pose:0});
  for(const [view,poses] of Object.entries(info.sheets)) if(!view.startsWith('rig:'))poses.forEach((p,i)=>{if(p&&!p.lips)sources.push({kind:'source',view,pose:i});});
  const views=[...new Set([info.imagePose?.atlas,...Object.values(info.sheets).flatMap(p=>p.map(v=>v?.atlas))].filter((v):v is string=>!!v))];
  const patches=views.filter(v=>!info.frames?.[v]).flatMap(view=>MouthName.options.map(mouth=>({kind:'patch' as const,view,mouth})));
  if(!target)return {revision,pending:[...sources,...patches]};
  let image:Buffer;
  if(target.kind==='source') {
    const pose=target.view==='image'?info.imagePose:info.sheets[target.view]?.[target.pose];
    if(!pose || target.view==='image'&&target.pose!==0 || target.view.startsWith('rig:'))throw new Error('No current source pose');
    const model=target.view.startsWith('model:');
    const path=target.view==='image'?files.path('cast',`${key}.png`):files.path('cast',key,model?'model':'sprites',model?target.view.slice(6):target.view);
    const grid=target.view==='image'||model?{cols:1,rows:1}:files.readJson(files.path('cast',key,'sprites','sprites.json')) as {cols:number;rows:number};
    image=(await sourceLipCrop(fs.readFileSync(path),grid.cols,grid.rows,pose,target.pose)).image;
  } else {
    if(!views.includes(target.view))throw new Error('No current patch view');
    const mouths=target.view==='default'?info.mouths:info.atlases?.[target.view];
    if(!mouths)throw new Error('No current mouth patch');
    const atlas=fs.readFileSync(files.path('cast',key,info.image)),meta=await sharp(atlas).metadata();
    image=await sharp(atlas).extract(pixelCrop(mouths[target.mouth],meta.width!,meta.height!)).resize(512,512,{fit:'fill'}).png().toBuffer();
  }
  return {revision,target,imageHash:sha256(image),image,box:reviewedLips(files,key,image)?.box};
}
export async function setFaceCalibration(files:WorldFiles,key:string,target:Target,revision:string,imageHash:string,box:Box,open:boolean) {
  FaceRevision.parse(revision);FaceRevision.parse(imageHash);LipBox.parse(box);
  const current=await inspectFaceCalibration(files,key,target);
  if(!current.image || current.revision!==revision || current.imageHash!==imageHash || sha256(fs.readFileSync(files.path('cast',key,'face-candidate.json')))!==revision)throw new Error('Face calibration changed; inspect it again');
  files.write(files.path('cast',key,'lip-reviews',`${imageHash}.json`),{box,open});
}
