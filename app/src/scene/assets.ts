// What the build made for the cast and the sound, apart from whether the places are playable: verify checks the
// places' geometry, and says nothing of a character with no walk or a bed that stayed silent.
import fs from 'node:fs';
import { modelProblem } from '../model/glb.ts';
import { liveVoiceFailures } from '../sound/data.ts';
import { SoundManifest } from '../sound/make.ts';
import { Voices } from '../sound/voices.ts';
import type { WorldFiles } from '../world/files.ts';
import { players } from '../world/drawings.ts';
import { readBodies } from './cast.ts';

export function assetReport(files: WorldFiles): string[] {
  const world = files.world();
  const keys = [world.hero.key, ...world.places.flatMap((p) => p.things.filter((t) => t.role === 'npc').map((t) => t.key)), ...players(files).map((p) => p.key)];
  const has = (...f: string[]) => fs.existsSync(files.path(...f));
  const model = (k: string) => has('cast', k, 'model', 'model.json') && !modelProblem(files.path('cast', k, 'model'));
  const lines: string[] = [];
  const count = (name: string, test: (k: string) => boolean, of = keys) => {
    const missing = of.filter((k) => !test(k));
    lines.push(`${name} ${of.length - missing.length}/${of.length}${missing.length ? ` (none: ${missing.join(', ')})` : ''}`);
  };
  count('figures', (k) => has('cast', `${k}.png`));
  // A creature (not upright) moves as one body: it has no rig to miss.
  const bodies = readBodies(files, fs.existsSync);
  count('rig', (k) => has('cast', k, 'rig.json'), keys.filter((k) => has('cast', `${k}.png`) && bodies[k]?.upright !== false));
  if (keys.some(model) || keys.some((k) => has('cast', k, 'model'))) count('3D model', model, keys.filter((k) => has('cast', k, 'model')));
  if (has('voices.json')) {
    const v = Voices.safeParse(files.readJson(files.path('voices.json')));
    const failed = liveVoiceFailures(files);
    if (v.success) lines.push(`voices ${v.data.lines.length} lines spoken${failed.length ? `, ${failed.length} not (${[...new Set(failed.map((f) => f.speaker))].join(', ')})` : ''}`);
  }
  if (has('sound', 'sounds.json')) {
    const m = SoundManifest.safeParse(files.readJson(files.path('sound', 'sounds.json')));
    if (m.success) lines.push(`sounds ${Object.keys(m.data.sounds).length} made${Object.keys(m.data.failures).length ? `, ${Object.keys(m.data.failures).length} silent (${Object.keys(m.data.failures).join(', ')}: sound_redo)` : ''}`);
  }
  return lines;
}
