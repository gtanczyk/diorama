// The person's corrections to single sounds (sound_redo): a hint added to Spark's prompt, or simply another take.
// Kept in sound/fixes.json, so a rebuild or a new sound plan keeps them; the plan itself stays Spark's.
import fs from 'node:fs';
import { z } from 'zod';
import type { WorldFiles } from '../world/files.ts';

export const SoundFixes = z.record(z.string(), z.object({
  /** Words added to the sound's prompt ("louder, a clear clock tick"). */
  hint: z.string().optional(),
  /** Takes asked for again: each new round asks ElevenLabs for new takes instead of the cached ones. */
  take: z.number().int().min(0).optional(),
}));
export type SoundFixes = z.infer<typeof SoundFixes>;

export const soundFixesFile = (files: WorldFiles) => files.path('sound', 'fixes.json');

export function readSoundFixes(files: WorldFiles): SoundFixes {
  try {
    return SoundFixes.parse(JSON.parse(fs.readFileSync(soundFixesFile(files), 'utf8')));
  } catch {
    return {};
  }
}
