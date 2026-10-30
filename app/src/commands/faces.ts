import fs from 'node:fs';
import { defineCommand, takeOption } from '../registry.ts';
import { WorldFiles } from '../world/files.ts';
import { players } from '../world/drawings.ts';
import { prepareFace } from '../scene/faces.ts';
import { prepareLipSync } from '../sound/lipsync-make.ts';

export function faceCharacters(files: WorldFiles): string[] {
  const world = files.world();
  return [...new Set([world.hero.key, ...world.places.flatMap(p => p.things.filter(t => t.role === 'npc').map(t => t.key)), ...players(files).map(p => p.key)])];
}

defineCommand({
  name: 'faces',
  usage: 'faces <slug> [key...]    prepare speaking faces for paintings, 2D rigs and talk sprites, and cached audio lip-sync [--audio-only] [--image-only] [--force] [--take N] [--rhubarb PATH]',
  async run(args) {
    const take = Number(takeOption(args, 'take', '0'));
    const executable = takeOption(args, 'rhubarb', '');
    const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? (args.splice(i, 1), true) : false; };
    const audioOnly = flag('audio-only'), imageOnly = flag('image-only'), force = flag('force');
    const [slug, ...only] = args;
    if (!slug) throw new Error('usage: diorama faces <slug> [key...]');
    const files = new WorldFiles(slug), keys = faceCharacters(files);
    for (const key of only) if (!keys.includes(key)) throw new Error(`${slug} has no character ${key}`);
    const failures: string[] = [];
    if (!audioOnly) for (const key of keys.filter(k => !only.length || only.includes(k))) {
      try { await prepareFace(files, key, { take, force, imageOnly }); }
      catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        files.write(files.path('cast', key, 'face-attempt.json'), { at: new Date().toISOString(), state: 'failed', take, reason });
        console.log(`${key}: face preparation failed; existing face retained: ${reason}`);
        failures.push(`${key}: ${reason}`);
      }
    }
    if (fs.existsSync(files.path('voices.json'))) {
      const audio = await prepareLipSync(files, only, executable || undefined);
      for (const failure of audio.failures ?? []) failures.push(`${failure.speaker}: ${failure.reason}`);
    }
    if (failures.length) throw new Error(`${failures.length} face/audio preparation failures: ${failures.join('; ')}`);
  },
});
