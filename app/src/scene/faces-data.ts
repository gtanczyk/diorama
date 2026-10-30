// Validated, source-bound face assets. A repaint disables its old registrations, never another character.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { WorldFiles } from '../world/files.ts';
import { MOUTHS, type FaceDefinition } from '../play/lipsync.ts';

const Rect = z.tuple([z.number().nonnegative(), z.number().nonnegative(), z.number().positive(), z.number().positive()]);
const Pose = z.object({ mouth: Rect, eyes: z.array(Rect).max(2), lips: Rect.optional(), suggestedLips:Rect.optional(), lipConfidence:z.number().optional(), sourceOpen:z.boolean().optional(), atlas: z.string().optional() });
const Mouths = z.object(Object.fromEntries(MOUTHS.map(m => [m, Rect])) as Record<typeof MOUTHS[number], typeof Rect>);
export const FaceAsset = z.object({ image: z.string(), mouths: Mouths, atlases: z.record(Mouths).optional(), anchors: z.record(Rect).optional(), frames: z.record(Mouths).optional(),
  sheets: z.record(z.array(Pose.nullable())), sheetHashes: z.record(z.string()).optional(), imagePose: Pose.optional(), rigPose: Pose.optional(), rigHash: z.string().optional(), imageHash: z.string().optional(), seed: z.number().optional(), sourceVersions: z.record(z.string()).optional() });
export const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
export function rigFingerprint(files: WorldFiles, key: string): string | undefined {
  const file = files.path('cast', key, 'rig.json');
  if (!fs.existsSync(file)) return;
  const rig = files.readJson(file) as { parts?: Array<{ file: string }> };
  const parts = (rig.parts ?? []).map(p => files.path('cast', key, p.file));
  if (parts.some(p => !fs.existsSync(p))) return;
  return sha256(Buffer.concat([fs.readFileSync(file), ...parts.map(p => fs.readFileSync(p))]));
}
export function faceSourceHash(files: WorldFiles, key: string, source: string): string {
  const rig = source.startsWith('rig:'), model = source.startsWith('model:');
  const file = rig ? files.path('cast', key, source.slice(4)) : model ? files.path('cast', key, 'model', source.slice(6)) : files.path('cast', key, 'sprites', source);
  const registration = rig ? files.path('cast', key, 'rig.json') : model ? files.path('cast', key, 'model', 'model.json') : undefined;
  return sha256(Buffer.concat([fs.readFileSync(file), ...(registration ? [fs.readFileSync(registration)] : [])]));
}
const safe = (value: string) => !!value && !value.includes('..') && !value.startsWith('/') && !value.includes('\\');

export function registeredFace(files: WorldFiles, key: string, manifest = 'face.json'): { dir: string; info: FaceDefinition } | undefined {
  const file = files.path('cast', key, manifest);
  if (!fs.existsSync(file)) return;
  try {
    const info = FaceAsset.parse(files.readJson(file));
    if (!safe(info.image) || !fs.existsSync(files.path('cast', key, info.image))) return;
    const source = files.path('cast', `${key}.png`);
    const imagePose = fs.existsSync(source) && info.imageHash === sha256(fs.readFileSync(source)) ? info.imagePose : undefined;
    const rigPose = imagePose && info.rigHash === rigFingerprint(files, key) ? info.rigPose : undefined;
    const sheets = Object.fromEntries(Object.entries(info.sheets).filter(([sheet]) => {
      const rig = sheet.startsWith('rig:'), model = sheet.startsWith('model:');
      const name = rig ? sheet.slice(4) : model ? sheet.slice(6) : sheet;
      if (!safe(name)) return false;
      const source = rig ? files.path('cast', key, name) : files.path('cast', key, model ? 'model' : 'sprites', name);
      return fs.existsSync(source) && (!rig || fs.existsSync(files.path('cast', key, 'rig.json'))) && (!model || fs.existsSync(files.path('cast', key, 'model', 'model.json'))) && info.sheetHashes?.[sheet] === faceSourceHash(files, key, sheet);
    }));
    if (imagePose || Object.keys(sheets).length) return { dir: `cast/${key}`, info: { ...info, imagePose, rigPose, sheets } };
  } catch { /* An unfinished face asset keeps the previous figure playable. */ }
}
