// diorama sound <slug>: Spark plans what the world sounds like (sound.json), then every sound is generated,
// checked and levelled into sound/<id>.mp3 with sound/sounds.json, which the play page mixes live.
import fs from 'node:fs';
import { defineCommand, takeOption } from '../registry.ts';
import { Brief } from '../scene/brief.ts';
import { Layout } from '../scene/layout.ts';
import { Kind, makeSounds, seedLibrary, SoundManifest } from '../sound/make.ts';
import { inputHash } from '../meta/memo.ts';
import { planIssues, SoundPlan, withoutStrayLoops, writeSoundPlan, type PlaceSources } from '../sound/plan.ts';
import { creditGuard, soundQuality } from '../sound/cost.ts';
import { elevenKey, musicgenPython } from '../sound/sources.ts';
import { Story } from '../story/schema.ts';
import { WorldFiles } from '../world/files.ts';

defineCommand({
  name: 'sound',
  usage: 'sound <slug>             plan and generate ambience, loops, footsteps, one-shots and music [--replan] [--plan-only] [--only bed,loop,step,shot,music] [--music auto|musicgen|eleven] [--draft: shorter loops and cheaper speech; final quality is the default]',
  async run(args) {
    // Keep this generation at one quality even if Setup changes while it runs.
    process.env.DIORAMA_SOUND = soundQuality(args);
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

    // sound.json is the plan people may edit. It is made again with --replan, or when what it was made from
    // (world, story, briefs, floors) has changed since, so its shots and loops keep matching the story's things.
    const planFile = files.path('sound.json');
    const from = inputHash(JSON.stringify(world), JSON.stringify(story), JSON.stringify(sources));
    const old = fs.existsSync(planFile) ? SoundPlan.parse(files.readJson(planFile)) : undefined;
    let plan: SoundPlan;
    if (old && !replan && old.from === from) plan = old;
    else {
      if (old && !replan) console.log('the world, story or paintings changed since sound.json was planned: planning again (hand edits to it are replaced)');
      plan = { from, ...withoutStrayLoops(await writeSoundPlan(files.memo, world, story, sources), world) };
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

    const guard = await creditGuard(elevenKey(), 'sound');
    const python = musicFrom === 'eleven' ? undefined : musicgenPython();
    if (musicFrom === 'musicgen' && !python) throw new Error('--music musicgen needs DIORAMA_PYTHON pointing at a Python with torch, transformers and scipy');
    console.log(`music: ${python ? 'MusicGen (Meta open weights) on this machine' : 'ElevenLabs (set DIORAMA_PYTHON to a Python with torch + transformers for MusicGen)'}`);
    const manifestFile = files.path('sound', 'sounds.json');
    const made0: SoundManifest = fs.existsSync(manifestFile) ? SoundManifest.parse(files.readJson(manifestFile)) : { sounds: {}, failures: {} };
    const kinds = only ? only.split(',').map((k) => Kind.parse(k.trim())) : undefined;
    const made = await makeSounds(files.memo, plan, (id, mp3) => {
      files.write(files.path('sound', `${id}.mp3`), mp3);
      return `sound/${id}.mp3`;
    }, { python, only: kinds, log: (line) => console.log(line), old: made0.sounds, have: (e) => fs.existsSync(files.path(e.file)) });
    // A partial run keeps what it did not touch.
    const sounds = { ...(kinds ? made0.sounds : {}), ...made.sounds };
    // Failed replacements cannot silently retain the rejected prior asset in a partial rebuild.
    for (const id of Object.keys(made.failures)) delete sounds[id];
    const failures = { ...(kinds && 'failures' in made0 ? made0.failures : {}), ...made.failures };
    for (const id of Object.keys(made.sounds)) delete failures[id];
    files.write(manifestFile, { sounds, failures });
    for (const [id, e] of Object.entries(sounds)) if (fs.existsSync(files.path(e.file))) seedLibrary(id, e, fs.readFileSync(files.path(e.file)));
    const s = files.memo.sent;
    console.log(`sound ${slug}: ${Object.keys(sounds).length} sounds · sent: spark ${s.spark}, sound ${s.sound}, music ${s.music} · ${await guard.report()} · ${manifestFile}`);
    // A thing's own loop that never passed stays silent under its place's bed (a lamp's hum is near silence anyway);
    // music, beds, steps and one-shots carry the world, so those fail the step.
    const failed = Object.keys(failures).filter((id) => !id.endsWith('-loop'));
    const quiet = Object.keys(failures).filter((id) => id.endsWith('-loop'));
    if (quiet.length) console.log(`  silent: ${quiet.join(', ')} (their loops failed the quality checks; the place bed plays)`);
    if (failed.length) throw new Error(`${failed.length} sounds failed quality or generation; see sound/sounds.json failures`);
  },
});
