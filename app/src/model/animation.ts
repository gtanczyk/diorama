// Per-character choices live outside generated model/ and sprites/ so regeneration keeps them.
import fs from 'node:fs';
import { z } from 'zod';
import { hasModelTexture } from './glb.ts';
import type { WorldFiles } from '../world/files.ts';

const Texture = z.enum(['views', 'model']);
const Frames = z.union([z.literal(8), z.literal(16), z.literal(32)]);
const Settings = z.object({ texture: Texture, frames: Frames, coatCorrection: z.boolean().optional(), automatic: z.literal(true).optional() });
export type AnimationSettings = z.infer<typeof Settings>;

/** Existing choices win; new characters select UV/16 only when their actual model supports it. */
export function animationSettings(files: WorldFiles, key: string, patch: Partial<AnimationSettings> = {}, candidate?: Buffer): AnimationSettings {
  const file = files.path('cast', key, 'animation.json');
  const saved = fs.existsSync(file) ? Settings.parse(files.readJson(file)) : undefined;
  const modelFile = files.path('cast', key, 'model', 'model.json');
  const model = fs.existsSync(modelFile) ? files.readJson(modelFile) as { texture?: string } : undefined;
  const legacy = !saved && model?.texture !== 'model' && fs.existsSync(files.path('cast', key, 'sprites', 'sprites.json'));
  const automatic = patch.texture === undefined && patch.frames === undefined && (!saved || saved.automatic) && !legacy;
  const glbFile = files.path('cast', key, 'model', 'model.glb');
  const glb = candidate ?? (fs.existsSync(glbFile) ? fs.readFileSync(glbFile) : undefined);
  const texture = automatic ? glb && hasModelTexture(glb) ? 'model' : 'views' : patch.texture ?? saved?.texture ?? 'views';
  const changedMode = patch.texture !== undefined && patch.texture !== saved?.texture;
  const frames = automatic ? texture === 'model' ? 16 : 8 : patch.frames ?? (changedMode ? texture === 'model' ? 16 : 8 : saved?.frames ?? (texture === 'model' ? 16 : 8));
  // Automatic UV starts with the rig's own weights. A historical coat override remains respected.
  const coatCorrection = patch.coatCorrection ?? saved?.coatCorrection ?? (automatic && texture === 'model' ? false : undefined);
  const settings = Settings.parse({ texture, frames, ...(coatCorrection !== undefined && { coatCorrection }), ...(automatic && { automatic: true }) });
  if (texture === 'views' && frames !== 8) throw new Error('Painted views use 8 frames; use --texture model for 16 or 32 frames');
  return settings;
}

export function animationOptions(texture: string, frames = '', coat = ''): Partial<AnimationSettings> {
  return { ...(texture && { texture: Texture.parse(texture) }), ...(frames && { frames: Frames.parse(Number(frames)) }), ...(coat && { coatCorrection: z.enum(['on', 'off']).parse(coat) === 'on' }) };
}

export function saveAnimationSettings(files: WorldFiles, key: string, settings: AnimationSettings) {
  files.write(files.path('cast', key, 'animation.json'), settings);
}
