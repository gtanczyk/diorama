import fs from 'node:fs';
import path from 'node:path';
import { facialControl, isViseme } from '../play/face3d.ts';

export function modelFaceStatus(dir: string, paintedViews: string[] = []): { mouth: boolean; eyes: boolean; targets: number; method: 'morphs' | 'painted-surfaces' | null; views: string[]; reason: string | null } | null {
  const info = path.join(dir, 'model.json');
  if (!fs.existsSync(info)) return null;
  try {
    const model = JSON.parse(fs.readFileSync(info, 'utf8')) as { glb: string; texture?: string };
    const data = fs.readFileSync(path.join(dir, model.glb));
    if (data.readUInt32LE(0) !== 0x46546c67 || data.toString('ascii', 16, 20) !== 'JSON') throw new Error('invalid GLB');
    const gltf = JSON.parse(data.toString('utf8', 20, 20 + data.readUInt32LE(12)).trim()) as { meshes?: Array<{ extras?: { targetNames?: string[] }; primitives?: Array<{ targets?: unknown[] }> }> };
    const controls = (gltf.meshes ?? []).flatMap(m => m.extras?.targetNames ?? []).map(facialControl).filter(c => c !== undefined);
    const mouth = controls.some(c => c === 'jaw' || (isViseme(c) && c !== 'sil'));
    const eyes = controls.some(c => c.startsWith('blink'));
    const targets = (gltf.meshes ?? []).reduce((sum, m) => sum + Math.max(0, ...(m.primitives ?? []).map(p => p.targets?.length ?? 0)), 0);
    const surfaces = (model as {texture?:string}).texture !== 'model' ? paintedViews : [];
    return { mouth: mouth || surfaces.length > 0, eyes: eyes || surfaces.length > 0, targets, method: mouth ? 'morphs' : surfaces.length ? 'painted-surfaces' : null, views: surfaces,
      reason: mouth || surfaces.length ? null : 'The 3D model needs facial morphs or calibrated painted facial surfaces.' };
  } catch { return { mouth: false, eyes: false, targets: 0, method:null, views:[], reason: 'The 3D facial controls could not be inspected.' }; }
}
