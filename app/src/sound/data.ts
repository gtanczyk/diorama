// The play page's SoundData from sound.json (the plan) and sound/sounds.json (what was made).
import fs from 'node:fs';
import type { SoundData } from '../play/sound.ts';
import { Layout } from '../scene/layout.ts';
import type { WorldFiles } from '../world/files.ts';
import { SoundManifest } from './make.ts';
import { SoundPlan, soundIds } from './plan.ts';
import { jobsOf } from './make.ts';
import { readSoundFixes } from './fixes.ts';
import { storyLines, Voices } from './voices.ts';
import { Story } from '../story/schema.ts';

/**
 * The spoken lines the last voices run could not make that the story still has. A line rewritten since (story_text)
 * is history, not a missing recording: story_status unvoiced lists the new wording until voices runs again.
 */
export function liveVoiceFailures(files: WorldFiles): Voices['failures'] {
  const voicesFile = files.path('voices.json');
  if (!fs.existsSync(voicesFile)) return [];
  const voices = Voices.safeParse(files.readJson(voicesFile));
  if (!voices.success) return [];
  try {
    const world = files.world();
    const story = Story.parse(files.readJson(files.path('story.json')));
    const live = new Set(storyLines(world, story, true).map((l) => JSON.stringify([l.speaker, l.text])));
    return voices.data.failures.filter((f) => live.has(JSON.stringify([f.speaker, f.text])));
  } catch {
    return voices.data.failures;
  }
}

export function soundData(files: WorldFiles): SoundData | undefined {
  const sound = effects(files);
  const voicesFile = files.path('voices.json');
  if (!fs.existsSync(voicesFile)) return sound;
  const recordings = Voices.parse(files.readJson(voicesFile)).lines
    .filter((l) => !l.flags.some((f) => f.startsWith('heard')) && fs.existsSync(files.path(l.file)));
  const lines: NonNullable<SoundData['lines']> = {};
  const bySpeaker: NonNullable<SoundData['bySpeaker']> = {};
  for (const l of recordings) {
    const entry = { file: l.file, seconds: l.seconds, speaker: l.speaker };
    (bySpeaker[l.speaker] ??= {})[l.text] = entry;
    if (recordings.filter((r) => r.text === l.text).length === 1) lines[l.text] = entry;
  }
  return { ...(sound ?? { files: {}, places: {}, shots: {} }), lines, bySpeaker };
}

function effects(files: WorldFiles): SoundData | undefined {
  const planFile = files.path('sound.json');
  const madeFile = files.path('sound', 'sounds.json');
  if (!fs.existsSync(planFile) || !fs.existsSync(madeFile)) return undefined;
  const plan = SoundPlan.parse(files.readJson(planFile));
  const made = SoundManifest.parse(files.readJson(madeFile)).sounds;
  const wanted = new Map(jobsOf(plan, readSoundFixes(files)).map((j) => [j.id, j.prompt]));
  const have = (id: string) => (made[id] && made[id].prompt === wanted.get(id)
    && !made[id].flags.some((f) => /does not loop well|still hissy|only \d+ footstep/.test(f))
    && fs.existsSync(files.path(made[id].file)) ? id : undefined);
  const data: SoundData = {
    files: Object.fromEntries(Object.entries(made).filter(([id]) => have(id)).map(([id, s]) => [id, { file: s.file, kind: s.kind, level: s.level, ...(s.slices && { slices: s.slices }) }])),
    music: have(soundIds.music()),
    places: {},
    shots: {},
  };
  for (const place of files.world().places) {
    const p = plan.places[place.key];
    if (!p) continue;
    const layoutFile = files.place(place.key, 'layout.json');
    const floors = fs.existsSync(layoutFile) ? Layout.parse(files.readJson(layoutFile)).floors : [];
    data.places[place.key] = {
      bed: have(soundIds.bed(place.key)),
      loops: p.loops.flatMap((l) => {
        const id = have(soundIds.loop(place.key, l.thing));
        return id ? [{ id, thing: l.thing, level: l.level, when: l.when }] : [];
      }),
      zones: floors.map((f) => (p.floors[f.key] ? have(soundIds.step(p.floors[f.key])) ?? null : null)),
    };
  }
  for (const shot of plan.shots) {
    const id = have(soundIds.shot(shot.on));
    if (id) data.shots[shot.on] = id;
  }
  return data;
}
