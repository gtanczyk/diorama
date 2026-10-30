// Optional, precomputed cues only apply to the exact final audio analysed by the prototype.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { WorldFiles } from '../world/files.ts';
import { MOUTHS, type LipSync, type MouthCue } from '../play/lipsync.ts';

export function lipSyncData(files: WorldFiles): Record<string, LipSync> {
  const file = files.path('sound', 'lipsync.json');
  if (!fs.existsSync(file)) return {};
  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as { version: number; byFile: Record<string, LipSync & { sha256: string }> };
    if (manifest.version !== 1) return {};
    return Object.fromEntries(Object.entries(manifest.byFile).filter(([audio, data]) => {
      if (!data || typeof data !== 'object') return false;
      if (data.step !== undefined && (!Number.isFinite(data.step) || data.step <= 0)) return false;
      if (data.envelope !== undefined && (!Array.isArray(data.envelope) || !data.envelope.every(v => Number.isFinite(v) && v >= 0 && v <= 1))) return false;
      if (!audio.startsWith('sound/voice/') || audio.includes('..') || !fs.existsSync(files.path(audio))) return false;
      if (createHash('sha256').update(fs.readFileSync(files.path(audio))).digest('hex') !== data.sha256) return false;
      return Array.isArray(data.cues) && data.cues.length > 0 && data.cues.every((cue: MouthCue, i: number) =>
        !!cue && MOUTHS.includes(cue.value) && Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.start >= 0 && cue.end > cue.start
        && (!i || cue.start >= data.cues[i - 1].end));
    }).map(([audio, { cues, envelope, step }]) => [audio, { cues, envelope, step }]));
  } catch { return {}; } // An old or unfinished prototype never prevents a world from playing.
}
