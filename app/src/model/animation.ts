// Per-character choices live outside generated model/ and sprites/ so regeneration keeps them.
import fs from 'node:fs';
import { z } from 'zod';
import type { WorldFiles } from '../world/files.ts';

const Texture = z.enum(['views', 'model']);
const Frames = z.union([z.literal(8), z.literal(16), z.literal(32)]);
const Settings = z.object({ texture: Texture, frames: Frames, coatCorrection: z.boolean().optional() });
export type AnimationSettings = z.infer<typeof Settings>;

/** Missing options preserve the legacy painted eight-frame workflow. */
export function animationSettings(files: WorldFiles, key: string, patch: Partial<AnimationSettings> = {}): AnimationSettings {
  const file = files.path('cast', key, 'animation.json');
  const saved = fs.existsSync(file) ? Settings.parse(files.readJson(file)) : undefined;
  const texture = patch.texture ?? saved?.texture ?? 'views';
  const frames = patch.frames ?? (patch.texture === 'views' ? 8 : saved?.frames ?? (texture === 'model' ? 16 : 8));
  const coatCorrection = patch.coatCorrection ?? saved?.coatCorrection;
  const settings = Settings.parse({ texture, frames, ...(coatCorrection !== undefined && { coatCorrection }) });
  if (texture === 'views' && frames !== 8) throw new Error('Painted views use 8 frames; use --texture model for 16 or 32 frames');
  return settings;
}

export function animationOptions(texture: string, frames = '', coat = ''): Partial<AnimationSettings> {
  return { ...(texture && { texture: Texture.parse(texture) }), ...(frames && { frames: Frames.parse(Number(frames)) }), ...(coat && { coatCorrection: z.enum(['on', 'off']).parse(coat) === 'on' }) };
}

export function saveAnimationSettings(files: WorldFiles, key: string, settings: AnimationSettings) {
  files.write(files.path('cast', key, 'animation.json'), settings);
}
