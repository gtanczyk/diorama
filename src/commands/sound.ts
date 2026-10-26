// diorama sound <slug>: Spark plans what the world sounds like (sound.json), then every sound is generated,
// checked and levelled into sound/<id>.mp3 with sound/sounds.json, which the play page mixes live.
import fs from 'node:fs';
import { defineCommand, takeOption } from '../registry.ts';
import { Brief } from '../scene/brief.ts';
import { Layout } from '../scene/layout.ts';
import { Kind, makeSounds, SoundManifest } from '../sound/make.ts';
import { planIssues, SoundPlan, writeSoundPlan, type PlaceSources } from '../sound/plan.ts';
import { elevenKey, musicgenPython } from '../sound/sources.ts';
import { Story } from '../story/schema.ts';
import { WorldFiles } from '../world/files.ts';

defineCommand({
  name: 'sound',
  usage: 'sound <slug>             plan and generate ambience, loops, footsteps, one-shots and music [--replan] [--plan-only] [--only bed,loop,step,shot,music] [--music auto|musicgen|eleven]',
  async run(args) {
    const replan = args.includes('--replan');
    const planOnly = args.includes('--plan-only');
    const only = takeOption(args, 'only', '');
    // auto: MusicGen when DIORAMA_PYTHON is set up for it, else ElevenLabs.
    const musicFrom = takeOption(args, 'music', 'auto');
    if (!['auto', 'musicgen', 'eleven'].includes(musicFrom)) throw new Error('--music takes auto, musicgen or eleven');
    const [slug] = args.filter((a) => !a.startsWith('--'));
    if (!slug) throw new Error('usage: diorama sound <slug>');
    const files = new WorldFiles(slug);
    const world = files.world();
    const story = fs.existsSync(files.path('story.json')) ? Story.parse(files.readJson(files.path('story.json'))) : null;
    const sources: Record<string, PlaceSources> = {};
    for (const place of world.places) {
      const read = <T>(file: string, schema: { parse: (v: unknown) => T }) => (fs.existsSync(files.place(place.key, file)) ? schema.parse(files.readJson(files.place(place.key, file))) : undefined);
      sources[place.key] = { brief: read('brief.json', Brief), layout: read('layout.json', Layout) };
    }

    // sound.json is the plan people may edit; it is only re-asked with --replan.
    const planFile = files.path('sound.json');
    let plan: SoundPlan;
    if (fs.existsSync(planFile) && !replan) plan = SoundPlan.parse(files.readJson(planFile));
    else {
      plan = await writeSoundPlan(files.memo, world, story, sources);
      files.write(planFile, plan);
    }
    const issues = planIssues(plan, world, sources);
    const loops = Object.values(plan.places).reduce((n, p) => n + p.loops.length, 0);
    console.log(`plan: music, ${Object.keys(plan.places).length} beds, ${loops} loops, ${Object.keys(plan.steps).length} surfaces, ${plan.shots.length} one-shots · ${planFile}`);
    for (const issue of issues) console.log(`  flag   ${issue}`);
    if (planOnly) return;
    if (!elevenKey()) {
      console.log('no ELEVENLABS_API_KEY: the plan is written, no sounds generated; the world plays silent');
      return;
    }

    const python = musicFrom === 'eleven' ? undefined : musicgenPython();
    if (musicFrom === 'musicgen' && !python) throw new Error('--music musicgen needs DIORAMA_PYTHON pointing at a Python with torch, transformers and scipy');
    console.log(`music: ${python ? 'MusicGen (Meta open weights) on this machine' : 'ElevenLabs (set DIORAMA_PYTHON to a Python with torch + transformers for MusicGen)'}`);
    const manifestFile = files.path('sound', 'sounds.json');
    const old = fs.existsSync(manifestFile) ? SoundManifest.parse(files.readJson(manifestFile)) : { sounds: {} };
    const kinds = only ? only.split(',').map((k) => Kind.parse(k.trim())) : undefined;
    const made = await makeSounds(files.memo, plan, (id, mp3) => {
      files.write(files.path('sound', `${id}.mp3`), mp3);
      return `sound/${id}.mp3`;
    }, { python, only: kinds, log: (line) => console.log(line) });
    // A partial run keeps what it did not touch.
    const sounds = { ...(kinds ? old.sounds : {}), ...made.sounds };
    files.write(manifestFile, { sounds });
    const s = files.memo.sent;
    console.log(`sound ${slug}: ${Object.keys(sounds).length} sounds · sent: spark ${s.spark}, sound ${s.sound}, music ${s.music} · ${manifestFile}`);
  },
});
