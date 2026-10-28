// Setup checks and moving the view. Storing a key is deliberately not an action: keys are typed only
// into `diorama setup` in a terminal, never into the GUI or through the agent.
import { z } from 'zod';
import { runChecks } from '../setup/checks.ts';
import { Slug } from '../world/schema.ts';
import { defineAction } from './registry.ts';

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
