import fs from 'node:fs';
import { z } from 'zod';
import { modelFaceStatus } from '../model/face.ts';
import { faceCharacters } from '../commands/faces.ts';
import { registeredFace } from '../scene/faces-data.ts';
import { WorldFiles } from '../world/files.ts';
import { Slug } from '../world/schema.ts';
import { lipSyncData } from '../sound/lipsync.ts';
import { agentBlocked } from '../studio/locks.ts';
import { ActionError, defineAction } from './registry.ts';

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
  name: 'faces_prepare', job: true,
  description: 'Prepare speaking faces automatically for a character or the cast: locate facial features, paint and validate reusable mouth shapes for each visible view, register image/rig/talk poses, analyse final recordings. Costs up to two image attempts per new/changed view plus vision calls. Unchanged assets and audio reuse their cache. Existing faces remain active on failure. Wait for the job, check faces_status, then play_reload.',
  input: z.object({ slug: Slug, key: Slug.optional(), audioOnly: z.boolean().optional(), anotherTake: z.boolean().optional() }),
  async run({ slug, key, audioOnly, anotherTake }, ctx) {
    const files = new WorldFiles(slug, ctx.root);
    const blocked = agentBlocked(files.dir, ctx.by);
    if (blocked) throw new ActionError(423, blocked);
    const keys = faceCharacters(files);
    if (key && !keys.includes(key)) throw new ActionError(404, `No character ${key}`);
    if (anotherTake && !key) throw new ActionError(400, 'Choose one character for another face take');
    let take = 0;
    if (key) {
      const previous = files.path('cast', key, 'face-attempt.json');
      if (fs.existsSync(previous)) take = Number((files.readJson(previous) as { take?: number }).take ?? 0);
      if (anotherTake) take++;
    }
    return ctx.jobs.start(slug, ['faces', slug, ...(key ? [key] : []), ...(audioOnly ? ['--audio-only'] : []), '--take', String(take), ...(anotherTake ? ['--force'] : [])], `prepare speaking faces${key ? ` ${key}` : ''}`, ctx.by);
  },
});
