// Setup checks and moving the view. Storing a key is deliberately not an action: keys are typed only
// into `diorama setup` in a terminal, never into the GUI or through the agent.
import { z } from 'zod';
import { runChecks } from '../setup/checks.ts';
import { Slug } from '../world/schema.ts';
import { defineAction } from './registry.ts';
import { soundQuality } from '../sound/cost.ts';
import { writeSoundQuality } from '../sound/settings.ts';
import { blenderEnv, blenderState, writeBlenderSettings } from '../model/blender.ts';
import { facesState, writeFacesSettings } from '../scene/faces-settings.ts';
import { installChromium } from '../commands/browsers.ts';
import { cli } from '../cli.ts';

const audioState = () => ({ quality: soundQuality(), env: process.env.DIORAMA_SOUND ?? null });

defineAction({
  name: 'audio_get',
  reads: true,
  description: 'Audio quality for new generations: final or draft, and any DIORAMA_SOUND override.',
  input: z.object({}),
  async run() { return audioState(); },
});

defineAction({
  name: 'audio_set',
  description: 'Save the machine-wide audio quality for future sound and voices generations. Existing recordings are unchanged.',
  input: z.object({ quality: z.enum(['final', 'draft']) }),
  async run({ quality }) {
    if (process.env.DIORAMA_SOUND !== undefined) throw new Error('DIORAMA_SOUND overrides Setup. Unset it and restart Studio to choose audio quality here.');
    writeSoundQuality(quality);
    return audioState();
  },
});

defineAction({
  name: 'blender_get',
  reads: true,
  description: 'Whether a local Blender relaxes 3D figures\' rest pose (arms down, feet under the hips) before they walk: found or not, on or off.',
  input: z.object({}),
  async run() { return blenderState(); },
});

defineAction({
  name: 'blender_set',
  description: 'Turn the local Blender step for 3D figures on or off for this machine. On: new models get a calm rest pose; cast_relax fixes existing ones.',
  input: z.object({ enabled: z.boolean() }),
  async run({ enabled }) {
    if (blenderEnv() !== undefined) throw new Error('DIORAMA_BLENDER overrides Setup. Unset it and restart Studio to switch Blender here.');
    writeBlenderSettings({ enabled });
    return blenderState();
  },
});

defineAction({
  name: 'faces_get',
  reads: true,
  description: 'Whether builds prepare talking mouths (the faces step) on this machine. Off by default.',
  input: z.object({}),
  async run() { return facesState(); },
});

defineAction({
  name: 'faces_set',
  description: 'Turn talking mouths on or off for builds on this machine (the person decides this in Setup; ask before changing it).',
  input: z.object({ enabled: z.boolean() }),
  async run({ enabled }) {
    if (facesState().env !== null) throw new Error('DIORAMA_FACES overrides Setup. Unset it and restart Studio to switch it here.');
    writeFacesSettings(enabled);
    return facesState();
  },
});

defineAction({
  name: 'setup_status',
  reads: true,
  description: 'What this machine has and still needs (Node, Meta key, Muse Code, Chromium, ElevenLabs, Python, publishing). Never returns a key, only where it comes from.',
  input: z.object({}),
  async run() {
    return runChecks();
  },
});

defineAction({
  name: 'setup_check',
  description: 'Like setup_status, plus one live call with the Meta key to prove it works.',
  input: z.object({}),
  async run() {
    return runChecks({ live: true });
  },
});

defineAction({
  name: 'setup_cli',
  reads: true,
  description: 'The command that runs diorama in a terminal on this machine (diorama, npx @gtanczyk/diorama or npm run diorama --), for hints to the person.',
  input: z.object({}),
  async run() {
    return { command: cli(), setup: cli('setup') };
  },
});

let downloading: Promise<unknown> | null = null;

defineAction({
  name: 'setup_browsers',
  description: 'Download Chromium for Explore, the playthrough bot and sprites (Playwright, ~150 MB, once), then check the machine again. Ask the person first.',
  input: z.object({}),
  async run(_input, ctx) {
    downloading ??= installChromium([], (line) => /\d%/.test(line) && !/100%/.test(line) ? undefined : ctx.events.publish('log', { stream: 'out', line: `chromium: ${line}` })).finally(() => (downloading = null));
    await downloading;
    return runChecks();
  },
});

defineAction({
  name: 'ui_focus',
  description: 'Point the Studio view at a world, a screen or a place, so the person sees what the agent is talking about (when they follow the agent).',
  input: z.object({
    slug: Slug.optional(),
    view: z.enum(['worlds', 'start', 'setup', 'workshop', 'story', 'cast', 'play']).optional()
      .describe('worlds: leave the world for the list of all worlds (start is the same); setup: keys and tools; workshop: the world\'s places; story, cast; play: the game'),
    place: Slug.optional(),
  }),
  async run(input, ctx) {
    // Pointing at a world or a place never means leaving it: "start" there reads as "begin at this place".
    const view = (input.view === 'start' || input.view === 'worlds') && (input.slug || input.place) ? 'workshop' : input.view === 'worlds' ? 'start' : input.view;
    ctx.events.publish('ui.focus', { ...input, ...(view && { view }), world: input.slug, by: ctx.by });
    return { ok: true };
  },
});

defineAction({
  name: 'play_reload',
  description: 'Reload the game the person is playing in the Studio, so it shows your change (opens it if they follow you and it is closed). '
    + 'Call it after a change they should see in play, instead of asking them to refresh.',
  input: z.object({ slug: Slug, place: Slug.optional() }),
  async run({ slug, place }, ctx) {
    ctx.events.publish('ui.focus', { slug, world: slug, view: 'play', reload: true, ...(place && { place }), by: ctx.by });
    return { ok: true };
  },
});

defineAction({
  name: 'ask_person',
  reads: true,
  description: 'Ask the person a question with a few answers to tap (yes/no, which of two fixes, go ahead or not), shown in the Studio as a card with buttons. '
    + 'Put the question here and not again in your text, then end your turn: their tap arrives as their next message, the answer\'s words exactly.',
  input: z.object({
    slug: Slug,
    question: z.string().min(3).max(300).describe('One short question, in the language of the person\'s newest message'),
    options: z.array(z.string().min(1).max(60)).min(2).max(4).describe('2 to 4 short answers, in that language: "Yes, rebuild it" and "No, leave it" rather than bare yes/no'),
    recommended: z.number().int().min(0).max(3).optional().describe('Index of the answer you advise'),
  }),
  async run(input, ctx) {
    ctx.events.publish('ui.ask', { ...input, world: input.slug, by: ctx.by });
    return { asked: true, next: 'End your turn now. The person\'s tap comes back as their next message.' };
  },
});
