// Source-bound, resumable work. Never served as a live face until all checks pass.
import fs from 'node:fs';
import { z } from 'zod';
import { sha256, faceSourceHash } from './faces-data.ts';
import type { WorldFiles } from '../world/files.ts';
import { MOUTHS } from '../play/lipsync.ts';

export const FaceWorkId = z.string().regex(/^[a-f0-9]{32}$/);
export const FaceRevision = z.string().regex(/^[a-f0-9]{64}$/);
export const LipBox = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().positive().max(1), z.number().positive().max(1)])
  .refine(([x,y,w,h]) => x+w <= 1 && y+h <= 1, 'Lip box must fit inside the image');
export const MouthName = z.enum(['X','A','B','C','D','E','F','G','H']);
const Rect = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const Located = z.object({ head: Rect, mouth: Rect, eyes: z.array(Rect), confidence: z.number() });
const Work = z.object({
  id: FaceWorkId, view: z.string(), sourceHash: z.string(), referenceHash: z.string(), take: z.number(),
  atlas: z.string().regex(/^face-work-[a-f0-9]{64}\.png$/).optional(),
  accepted: z.boolean().default(false), poses: z.array(Located.nullable()).optional(),
  lips: z.record(MouthName, LipBox).default({}), reviewed: z.array(MouthName).default([]),
  stage: z.enum(['atlas','articulation','lips','ready']).default('atlas'), reason: z.string().optional(),
  invalidFrames: z.array(z.number().int().min(0).max(8)).default([]),
});
export type FaceWork = z.infer<typeof Work>;
const file = (files: WorldFiles, key: string, id: string) => files.path('cast', key, 'face-work', `${FaceWorkId.parse(id)}.json`);
export const workRevision = (work: FaceWork) => sha256(JSON.stringify(Work.parse(work)));
export function currentFaceSource(files: WorldFiles, key: string, view: string) {
  if (view === 'image') return sha256(fs.readFileSync(files.path('cast', `${key}.png`)));
  if (!/^(model:)?[a-zA-Z0-9_-]+\.png$/.test(view)) throw new Error('Invalid face view');
  return faceSourceHash(files, key, view);
}
export function readFaceWork(files: WorldFiles, key: string, id: string, revision?: string): FaceWork {
  const work = Work.parse(files.readJson(file(files,key,id)));
  if (work.id !== id || currentFaceSource(files,key,work.view) !== work.sourceHash) throw new Error('Face source changed; prepare it again before repairing');
  if (revision !== undefined && workRevision(work) !== FaceRevision.parse(revision)) throw new Error('Face work changed; inspect it again before applying this correction');
  return work;
}
export function saveFaceWork(files: WorldFiles, key: string, work: FaceWork, atlas?: Buffer) {
  if (atlas) {
    work.atlas = `face-work-${sha256(atlas)}.png`;
    files.write(files.path('cast',key,work.atlas),atlas);
  }
  const target = file(files,key,work.id);
  files.write(`${target}.tmp`,work);
  fs.renameSync(`${target}.tmp`,target);
}
export function openFaceWork(files: WorldFiles, key: string, view: string, take: number, reference: Buffer): FaceWork {
  const sourceHash=currentFaceSource(files,key,view), referenceHash=sha256(reference);
  const id=sha256(JSON.stringify(['face-work-v1',view,sourceHash,referenceHash,take])).slice(0,32);
  if (fs.existsSync(file(files,key,id))) return readFaceWork(files,key,id);
  const work=Work.parse({id,view,sourceHash,referenceHash,take});
  files.write(files.path('cast',key,'face-work',`${id}-reference.png`),reference);
  saveFaceWork(files,key,work);
  return work;
}
export const faceWorkAtlas = (files: WorldFiles,key:string,work:FaceWork) => {
  if (!work.atlas) throw new Error('No atlas yet; prepare the face first');
  return fs.readFileSync(files.path('cast',key,work.atlas));
};
export const faceWorkReference = (files:WorldFiles,key:string,id:string) => fs.readFileSync(files.path('cast',key,'face-work',`${FaceWorkId.parse(id)}-reference.png`));
export function faceWorkList(files:WorldFiles,key:string) {
  const dir=files.path('cast',key,'face-work');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f=>/^[a-f0-9]{32}\.json$/.test(f)).flatMap(f=>{
    try { const work=readFaceWork(files,key,f.slice(0,-5)); return [{id:work.id,revision:workRevision(work),view:work.view,take:work.take,stage:work.stage,reason:work.reason,accepted:work.accepted,invalidFrames:work.invalidFrames.map(i=>MOUTHS[i]),pendingLips:MOUTHS.filter(m=>!work.lips[m])}]; }
    catch { return []; } // Old source-bound work is retained on disk, but cannot be applied to a repaint.
  });
}

export class FacePreparationError extends Error {
  constructor(readonly failures:string[]) { super(`${failures.length} face/audio preparation failures: ${failures.join('; ')}`); }
}
