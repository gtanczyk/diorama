import fs from 'node:fs';
import { CalibrationTarget, inspectFaceCalibration } from '../scene/face-calibration.ts';
import sharp from 'sharp';
import { z } from 'zod';
import { modelFaceStatus } from '../model/face.ts';
import { faceCharacters } from '../commands/faces.ts';
import { registeredFace } from '../scene/faces-data.ts';
import { WorldFiles } from '../world/files.ts';
import { Slug } from '../world/schema.ts';
import { lipSyncData } from '../sound/lipsync.ts';
import { agentBlocked } from '../studio/locks.ts';
import { ActionError, defineAction } from './registry.ts';
import { placeTrouble } from '../studio/trouble.ts';
import { FaceWorkId, FaceRevision, MouthName, LipBox, readFaceWork, faceWorkList, faceWorkAtlas, faceWorkReference, workRevision } from '../scene/face-work.ts';
import { MOUTHS } from '../play/lipsync.ts';

export function faceStatus(files: WorldFiles, key: string) {
  const face = registeredFace(files, key);
  const attempt = files.path('cast', key, 'face-attempt.json');
  const spritesFile = files.path('cast',key,'sprites','sprites.json');
  const spritePlan = fs.existsSync(spritesFile) ? files.readJson(spritesFile) as {cols:number;rows:number;talk?:Record<string,{sheet:string;gestures?:string[]}>} : undefined;
  const spritePoses = {registered:0,skipped:0,pending:0};
  for (const view of Object.values(spritePlan?.talk ?? {})) {
    const count=view.gestures?.length ?? spritePlan!.cols*spritePlan!.rows, poses=face?.info.sheets[view.sheet];
    for(let i=0;i<count;i++) {
      const p=poses?.[i];
      if(p===null) spritePoses.skipped++;
      else if(p?.lips && face?.info.frames?.[p.atlas ?? 'default'])spritePoses.registered++;
      else spritePoses.pending++;
    }
  }
  const modelViews = Object.entries(face?.info.sheets ?? {}).filter(([name,poses])=>name.startsWith('model:') && poses.some(p=>p?.lips && face?.info.frames?.[p.atlas ?? 'default'])).map(([name])=>name.slice(6));
  return { model3d: modelFaceStatus(files.path('cast', key, 'model'),modelViews), ready: !!face, spritePoses, image: !!face?.info.imagePose, rig: !!face?.info.rigPose || Object.keys(face?.info.sheets ?? {}).some(s => s.startsWith('rig:')),
    spriteViews: Object.keys(face?.info.sheets ?? {}).filter(s => !s.startsWith('rig:') && !s.startsWith('model:')).length,
    repairWork: faceWorkList(files,key),
    attempt: fs.existsSync(attempt) ? files.readJson(attempt) : null };
}

defineAction({
  name: 'faces_status', reads: true,
  description: 'Speaking-face coverage per character: image, 2D rig, registered talk sprite views, audio timelines and preparation failures. Includes native morphs or calibrated painted model surfaces. No model calls.',
  input: z.object({ slug: Slug, key: Slug.optional() }),
  async run({ slug, key }, ctx) {
    const files = new WorldFiles(slug, ctx.root), sync = lipSyncData(files);
    const voicesFile = files.path('voices.json');
    const lines = fs.existsSync(voicesFile) ? (files.readJson(voicesFile) as { lines: Array<{ speaker: string; file: string }> }).lines : [];
    return faceCharacters(files).filter(k => !key || k === key).map(key => ({ key, ...faceStatus(files, key), voicedLines: lines.filter(l => l.speaker === key).length,
      syncedLines: lines.filter(l => l.speaker === key && sync[l.file]).length }));
  },
});

defineAction({
  name:'faces_inspect', reads:true,
  description:'Inspect saved face work before a targeted repair. With id and mouth, returns the exact full-head cell, identity reference and normalized lip box. X is neutral, A MBP, B teeth, C EH, D AH, E OH, F OO, G FV, H L. Use the returned revision for face_frame_repair or face_lips_set. No model calls; stale source work is rejected.',
  input:z.object({slug:Slug,key:Slug,id:FaceWorkId.optional(),mouth:MouthName.optional()}),
  async run({slug,key,id,mouth},ctx) {
    const files=new WorldFiles(slug,ctx.root);
    if(!faceCharacters(files).includes(key))throw new ActionError(404,`No character ${key}`);
    if(!id)return {work:faceWorkList(files,key)};
    const work=readFaceWork(files,key,id), atlas=faceWorkAtlas(files,key,work);
    let image: Buffer=atlas;
    if(mouth) {
      const index=MOUTHS.indexOf(mouth),meta=await sharp(atlas).metadata(),w=meta.width!,h=meta.height!;
      const left=Math.floor(index%3*w/3),top=Math.floor(Math.floor(index/3)*h/3);
      image=await sharp(atlas).extract({left,top,width:Math.floor((index%3+1)*w/3)-left,height:Math.floor((Math.floor(index/3)+1)*h/3)-top}).png().toBuffer();
    }
    const meta=await sharp(image).metadata();
    return {...work,revision:workRevision(work),mouth,width:meta.width,height:meta.height,box:mouth?work.lips[mouth]:undefined,
      coordinates:mouth?'normalized [x,y,width,height] relative to the FIRST image, one full-head cell':'Select a mouth before calibrating; this image is the complete atlas',
      images:[image,faceWorkReference(files,key,id)].map(data=>({mimeType:'image/png',data:data.toString('base64')}))};
  },
});


/**
 * Speaking faces are the last polish, never ahead of a playable game: while a place is unpainted, being built or
 * left unplayable, the agent's face jobs wait (a face job queued first would hold the place repairs behind it,
 * and a live demo would hang on a cat's lips). The person can still ask for one from its card.
 */
export function placesFirst(files: WorldFiles, slug: string, ctx: { by: string; jobs: { list(world?: string): Array<{ state: string; args: string[] }> } }): string | null {
  if (ctx.by !== 'agent') return null;
  const world = fs.existsSync(files.path('world.json')) ? files.readJson(files.path('world.json')) as { places?: Array<{ key: string; title?: string }> } : {};
  const waiting = (world.places ?? []).filter((p) => !fs.existsSync(files.path('places', p.key, 'painting.png')) || placeTrouble(files.dir, p.key)).map((p) => p.title ?? p.key);
  const building = ctx.jobs.list(slug).some((j) => (j.state === 'queued' || j.state === 'running') && j.args[0] !== 'faces');
  if (!waiting.length && !building) return null;
  return `Places first: ${waiting.length ? `${waiting.join(', ')} ${waiting.length > 1 ? 'are' : 'is'} not playable yet` : 'a build or repair is still running'}. Speaking faces wait until every place plays (characters talk with gestures meanwhile). Repair the places (place_status, place_fix) and come back to faces after.`;
}

const RepairTarget={slug:Slug,key:Slug,id:FaceWorkId,revision:FaceRevision,mouth:MouthName};
for(const kind of ['repair','calibrate'] as const)defineAction({
  name:kind==='repair'?'face_frame_repair':'face_lips_set', job:true,
  description:kind==='repair'
    ? 'Repair ONE mouth frame from faces_inspect, with concrete visual guidance. One image edit then full atlas validation; other cells remain unchanged. Resumes face preparation using saved results. Use the exact inspected id/revision; do not repeatedly retry unchanged failures.'
    : 'Calibrate lips in an already accepted atlas using the full-head image from faces_inspect. Box is normalized [x,y,width,height] of the actual lip corners/opening, excluding beard/moustache. Inspect first; never guess coordinates or use this to bypass rejected articulation. Resumes preparation without repainting accepted mouths.',
  input:kind==='repair'
    ? z.object({...RepairTarget,hint:z.string().trim().min(1).max(1000),box:LipBox.optional()})
    : z.object({...RepairTarget,hint:z.string().optional(),box:LipBox}),
  async run({slug,key,id,revision,mouth,hint,box},ctx) {
    const files=new WorldFiles(slug,ctx.root),blocked=agentBlocked(files.dir,ctx.by);
    if(blocked)throw new ActionError(423,blocked);
    const later=placesFirst(files,slug,ctx);if(later)throw new ActionError(409,later);
    if(!faceCharacters(files).includes(key))throw new ActionError(404,`No character ${key}`);
    const work=readFaceWork(files,key,id,revision);
    if(kind==='calibrate'&&!work.accepted)throw new ActionError(409,'Repair articulation before calibrating the lips');
    return ctx.jobs.start(slug,['faces',slug,key,'--image-only','--take',String(work.take),kind==='repair'?'--repair-frame':'--calibrate-frame',id,'--revision',revision,'--mouth',mouth,...(kind==='repair'?['--hint',hint!]:['--box',JSON.stringify(box)])],`${kind==='repair'?'repair mouth':'calibrate lips'} ${key} ${mouth}`,ctx.by);
  },
});

defineAction({
  name: 'faces_prepare', job: true,
  description: 'Prepare speaking faces automatically for a character or the cast: locate facial features, paint and validate reusable mouth shapes for each visible view, register image/rig/talk poses, analyse final recordings. A rejected atlas gets one repair round: up to three individual mouth edits, or one full retry with validation feedback. Costs up to four image calls per new/changed view plus vision calls. Unchanged assets and audio reuse their cache. Existing faces remain active on failure. Wait for the job, check faces_status, then play_reload.',
  input: z.object({ slug: Slug, key: Slug.optional(), audioOnly: z.boolean().optional(), anotherTake: z.boolean().optional() }),
  async run({ slug, key, audioOnly, anotherTake }, ctx) {
    const files = new WorldFiles(slug, ctx.root);
    const blocked = agentBlocked(files.dir, ctx.by);
    if (blocked) throw new ActionError(423, blocked);
    const later=placesFirst(files,slug,ctx);if(later)throw new ActionError(409,later);
    const keys = faceCharacters(files);
    if (key && !keys.includes(key)) throw new ActionError(404, `No character ${key}`);
    if (anotherTake && !key) throw new ActionError(400, 'Choose one character for another face take');
    let take = 0;
    if (key) {
      const previous = files.path('cast', key, 'face-attempt.json');
      if (fs.existsSync(previous)) take = Number((files.readJson(previous) as { take?: number }).take ?? 0);
      if (anotherTake) take++;
    }
    return ctx.jobs.start(slug, ['faces', slug, '--image-only', ...(key ? [key] : []), ...(audioOnly ? ['--audio-only'] : []), '--take', String(take), ...(anotherTake ? ['--force'] : [])], `prepare speaking faces${key ? ` ${key}` : ''}`, ctx.by);
  },
});


defineAction({
  name:'face_calibration_inspect',reads:true,
  description:'Inspect pending source-pose or final-patch lip calibration after an atlas passed. Without target lists pending targets. With target returns the exact close-up and source-bound revision/imageHash for face_calibration_set. No model calls.',
  input:z.object({slug:Slug,key:Slug,target:CalibrationTarget.optional()}),
  async run({slug,key,target},ctx) {
    const files=new WorldFiles(slug,ctx.root);
    if(!faceCharacters(files).includes(key))throw new ActionError(404,`No character ${key}`);
    const {image,...result}=await inspectFaceCalibration(files,key,target);
    return {...result,coordinates:'normalized [x,y,width,height] relative to this one close-up; tight lip corners/opening, excluding facial hair',...(image&&{images:[{mimeType:'image/png',data:image.toString('base64')}]})};
  },
});
defineAction({
  name:'face_calibration_set',job:true,
  description:'Save inspected actual lip corners for a source pose or final cropped mouth patch and resume preparation. Requires exact target/revision/imageHash from face_calibration_inspect. Box normalized to its close-up; open means a visible mouth cavity. Never guess or use this to bypass rejected artwork. No new image generation for completed atlas views.',
  input:z.object({slug:Slug,key:Slug,target:CalibrationTarget,revision:FaceRevision,imageHash:FaceRevision,box:LipBox,open:z.boolean()}),
  async run({slug,key,target,revision,imageHash,box,open},ctx) {
    const files=new WorldFiles(slug,ctx.root),blocked=agentBlocked(files.dir,ctx.by);
    if(blocked)throw new ActionError(423,blocked);
    const later=placesFirst(files,slug,ctx);if(later)throw new ActionError(409,later);
    if(!faceCharacters(files).includes(key))throw new ActionError(404,`No character ${key}`);
    const current=await inspectFaceCalibration(files,key,target);
    if(current.revision!==revision||current.imageHash!==imageHash)throw new ActionError(409,'Face changed; inspect it again');
    const attempt=files.path('cast',key,'face-attempt.json');
    const take=fs.existsSync(attempt)?Number((files.readJson(attempt) as {take?:number}).take??0):0;
    return ctx.jobs.start(slug,['faces',slug,key,'--image-only','--take',String(take),'--calibration',JSON.stringify(target),'--revision',revision,'--image-hash',imageHash,'--box',JSON.stringify(box),'--open',String(open)],`calibrate speaking face ${key}`,ctx.by);
  },
});
