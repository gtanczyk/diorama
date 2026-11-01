import fs from 'node:fs';
import { castLanes, mapLimit } from '../world/pool.ts';
import { CalibrationTarget, setFaceCalibration } from '../scene/face-calibration.ts';
import { defineCommand, takeOption } from '../registry.ts';
import { WorldFiles } from '../world/files.ts';
import { players } from '../world/drawings.ts';
import { prepareFace, repairFaceFrame, calibrateFaceFrame } from '../scene/faces.ts';
import { registeredFace } from '../scene/faces-data.ts';
import { FacePreparationError, LipBox, MouthName } from '../scene/face-work.ts';
import { prepareLipSync } from '../sound/lipsync-make.ts';

export function faceCharacters(files: WorldFiles): string[] {
  const world = files.world();
  return [...new Set([world.hero.key, ...world.places.flatMap(p => p.things.filter(t => t.role === 'npc').map(t => t.key)), ...players(files).map(p => p.key)])];
}

defineCommand({
  name: 'faces',
  usage: 'faces <slug> [key...]    prepare speaking faces for paintings, 2D rigs and talk sprites, and cached audio lip-sync [--audio-only] [--image-only] [--force] [--take N] [--rhubarb PATH]',
  async run(args) {
    let take = Number(takeOption(args, 'take', '0'));
    let repairWorkId: string | undefined;
    const executable = takeOption(args, 'rhubarb', '');
    const repairId=takeOption(args,'repair-frame',''), calibrateId=takeOption(args,'calibrate-frame','');
    const revision=takeOption(args,'revision',''), mouth=takeOption(args,'mouth',''), hint=takeOption(args,'hint','');
    const box=takeOption(args,'box','');
    const calibration=takeOption(args,'calibration',''), imageHash=takeOption(args,'image-hash',''), open=takeOption(args,'open','');
    const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? (args.splice(i, 1), true) : false; };
    const audioOnly = flag('audio-only'), imageOnly = flag('image-only'), force = flag('force');
    const [slug, ...only] = args;
    if (!slug) throw new Error('usage: diorama faces <slug> [key...]');
    const files = new WorldFiles(slug), keys = faceCharacters(files);
    for (const key of only) if (!keys.includes(key)) throw new Error(`${slug} has no character ${key}`);
    if(calibration) {
      if(only.length!==1 || repairId || calibrateId || !['true','false'].includes(open))throw new Error('Choose one inspected calibration');
      await setFaceCalibration(files,only[0],CalibrationTarget.parse(JSON.parse(calibration)),revision,imageHash,LipBox.parse(JSON.parse(box)),open==='true');
    }
    if(repairId || calibrateId) {
      if(only.length!==1 || repairId && calibrateId) throw new Error('Choose one character and one face correction');
      const work = repairId ? await repairFaceFrame(files,only[0],repairId,revision,MouthName.parse(mouth),hint)
        : calibrateFaceFrame(files,only[0],calibrateId,revision,MouthName.parse(mouth),LipBox.parse(JSON.parse(box)));
      take = work.take; repairWorkId = work.id;
    }
    const statusFile = files.path('face-preparation.json');
    const status = fs.existsSync(statusFile) ? files.readJson(statusFile) as Record<string, { face?: string | null; audio?: string[] }> : {};
    for (const key of keys) if (!status[key]) {
      const attempt=files.path('cast',key,'face-attempt.json');
      if(fs.existsSync(attempt)) {
        const previous=files.readJson(attempt) as {state?:string;reason?:string};
        status[key]=previous.state==='failed'&&!registeredFace(files,key)?.info.imagePose?.lips?{face:previous.reason??'Face preparation failed'}:previous.state?{face:null}:{};
      }
    }
    const failures: string[] = [];
    // Each character's face is its own work (its own files under cast/<key>): a few side by side.
    if (!audioOnly) await mapLimit(keys.filter(k => !only.length || only.includes(k)), castLanes(), async (key) => {
      try { await prepareFace(files, key, { take, force, imageOnly, repairWorkId }); (status[key] ??= {}).face = null; }
      catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        files.write(files.path('cast', key, 'face-attempt.json'), { at: new Date().toISOString(), state: 'failed', take, reason });
        console.log(`${key}: face preparation failed; existing face retained: ${reason}`);
        // A retry (new talk sheets, a new take) that fails leaves the working face in place: the character
        // still speaks with moving lips, so the build is not short of faces. Asked for by name, it is reported.
        if (registeredFace(files, key)?.info.imagePose?.lips && !only.length) { (status[key] ??= {}).face = null; return; }
        failures.push(`${key}: ${reason}`);
        (status[key] ??= {}).face = reason;
      }
    });
    files.write(statusFile, status);
    if (fs.existsSync(files.path('voices.json'))) {
      const audio = await prepareLipSync(files, only, executable || undefined);
      for (const key of [...new Set([...keys, ...Object.keys(status)])].filter(k => !only.length || only.includes(k))) delete (status[key] ??= {}).audio;
      for (const failure of audio.failures ?? []) {
        failures.push(`${failure.speaker}: ${failure.reason}`);
        ((status[failure.speaker] ??= {}).audio ??= []).push(failure.reason);
      }
      files.write(statusFile, status);
    }
    if (failures.length) throw new FacePreparationError(failures);
  },
});
