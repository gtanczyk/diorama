// Bind generated motion to the source painting and, for sprites, the model that made it.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { WorldFiles } from '../world/files.ts';
type Kind = 'rig' | 'model' | 'sprites';
type Binding = { painting: string; model?: string };
const hash = (file: string) => fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : undefined;
const manifest = (files: WorldFiles, key: string) => files.path('cast', key, 'animation-source.json');
const existing = (files: WorldFiles, key: string, kind: Kind) => files.path('cast', key, kind === 'rig' ? 'rig.json' : kind === 'model' ? 'model/model.json' : 'sprites/sprites.json');
const read = (files: WorldFiles, key: string): Partial<Record<Kind, Binding>> => fs.existsSync(manifest(files,key)) ? files.readJson(manifest(files,key)) as Partial<Record<Kind, Binding>> : {};
const current = (files: WorldFiles, key: string, kind: Kind): Binding | undefined => {
  const painting = hash(files.path('cast',`${key}-painting.png`));
  if (!painting) return;
  const dir = files.path('cast', key, 'model');
  const names = ['model.glb','model.json','front.png','back.png','left.png','right.png'];
  const entries = kind === 'sprites' ? names.map(name => [name, hash(`${dir}/${name}`)] as const) : [];
  const model = entries.some(([, value]) => value) ? createHash('sha256').update(JSON.stringify(entries)).digest('hex') : undefined;
  return { painting, ...(model && {model}) };
};
/** Record legacy assets before replacing their source, without deleting paid work. */
export function bindExistingAnimation(files: WorldFiles, key: string) {
  const saved=read(files,key); let changed=false;
  for(const kind of ['rig','model','sprites'] as const) if(!saved[kind] && fs.existsSync(existing(files,key,kind))) {
    const source=current(files,key,kind); if(source) { saved[kind]=source; changed=true; }
  }
  if(changed)files.write(manifest(files,key),saved);
}
export function bindAnimation(files: WorldFiles,key:string,kind:Kind) {
  const source=current(files,key,kind); if(!source)return;
  const saved=read(files,key);saved[kind]=source;files.write(manifest(files,key),saved);
}
export function animationCurrent(files:WorldFiles,key:string,kind:Kind):boolean {
  const binding=read(files,key)[kind]; if(!binding)return true; // legacy remains usable until its source is replaced
  const source=current(files,key,kind);
  return !!source && source.painting===binding.painting && (!binding.model || source.model===binding.model);
}
