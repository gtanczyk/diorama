// Setup checks and moving the view. Storing a key is deliberately not an action: keys are typed only
// into `diorama setup` in a terminal, never into the GUI or through the agent.
import { z } from 'zod';
import { runChecks } from '../setup/checks.ts';
import { Slug } from '../world/schema.ts';
import { defineAction } from './registry.ts';

defineAction({
  name: 'setup_status',
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
    view: z.enum(['start', 'setup', 'workshop', 'story', 'cast', 'play']).optional(),
    place: Slug.optional(),
  }),
  async run(input, ctx) {
    ctx.events.publish('ui.focus', { ...input, world: input.slug, by: ctx.by });
    return { ok: true };
  },
});
