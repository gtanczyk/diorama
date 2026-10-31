// story.json: what the hero can do in the world and what it changes. Spark writes it, people may edit it.
import { z } from 'zod';
import { Slug } from '../world/schema.ts';

/** A condition is a list of facts that must all hold: "flag", "!flag", "has:item", "!has:item", "at:place". */
export const Fact = z.string().regex(/^!?(has:|at:)?[a-z][a-z0-9-]*$/, 'flag, !flag, has:item, !has:item or at:place');
export const When = z.array(Fact).default([]);

export const Effect = z.union([
  z.object({ set: Slug }),
  z.object({ clear: Slug }),
  z.object({ give: Slug }),
  z.object({ take: Slug }),
  z.object({ go: Slug }),
  z.object({ ending: Slug }),
  /** Send a person through an exit to a neighbouring place after this story action. */
  z.object({ moveNpc: z.object({ npc: Slug, to: Slug }) }),
]);

/** Clicking a thing in a place, optionally with an item from the inventory. */
export const Interaction = z.object({
  place: Slug,
  thing: Slug,
  verb: z.enum(['look', 'use', 'take', 'talk']),
  with: Slug.optional(),
  when: When,
  say: z.string().min(1),
  do: z.array(Effect).default([]),
  /** Spent after it fires once; the next matching interaction takes over. */
  once: z.boolean().default(false),
});

export const Choice = z.object({
  text: z.string().min(1),
  when: When,
  do: z.array(Effect).default([]),
  /** Node to go to; no next ends the conversation. */
  next: Slug.optional(),
});

export const Line = z.object({ key: Slug, says: z.string().min(1), choices: z.array(Choice).max(4).default([]) });

export const Dialogue = z.object({
  npc: Slug,
  place: Slug,
  when: When,
  start: Slug,
  lines: z.array(Line).min(1),
});

export const Story = z.object({
  intro: z.string().min(1),
  /** nope: what the hero says when the item is tried where it does not help. */
  items: z.array(z.object({ key: Slug, name: z.string().min(1), nope: z.string().min(1).optional() })),
  /** An exit in world.json that stays shut until its condition holds. */
  locks: z.array(z.object({ place: Slug, via: Slug, until: When, say: z.string().min(1) })).default([]),
  interactions: z.array(Interaction),
  dialogues: z.array(Dialogue).default([]),
  /** A thing that looks different once its condition holds (a beacon burning, a gate open): a plate painted over it. */
  changes: z.array(z.object({ place: Slug, thing: Slug, when: z.array(Fact).min(1), looks: z.string().min(3) })).default([]),
  /** Repeat a walk between the approach spots of these things; first matching patrol wins. */
  patrols: z.array(z.object({ npc: Slug, place: Slug, via: z.array(Slug).min(2).max(8), when: When,
    pause: z.number().min(0.5).max(60).default(2) })).optional(),
  endings: z.array(z.object({ key: Slug, title: z.string().min(1), text: z.string().min(1) })).min(1),
});

export type Story = z.infer<typeof Story>;
export type Effect = z.infer<typeof Effect>;
export type Interaction = z.infer<typeof Interaction>;
export type Dialogue = z.infer<typeof Dialogue>;

/**
 * The story as a model is held to it by structured outputs. The same story, except each effect is {op, key}: the
 * six one-key objects of Effect, twice over, make a grammar Anthropic refuses to compile ("too large").
 * fromWire turns the answer back; an answer already in Story's own shape passes through.
 */
const OPS = ['set', 'clear', 'give', 'take', 'go', 'ending', 'moveNpc'] as const;
const WireEffect = z.object({ op: z.enum(OPS), key: Slug, to: Slug.optional() });
export const WireStory = Story.extend({
  interactions: z.array(Interaction.extend({ do: z.array(WireEffect).default([]) })),
  dialogues: z.array(Dialogue.extend({ lines: z.array(Line.extend({ choices: z.array(Choice.extend({ do: z.array(WireEffect).default([]) })).max(4).default([]) })).min(1) })).default([]),
});

export function fromWire(answer: unknown): unknown {
  if (Array.isArray(answer)) return answer.map(fromWire);
  if (!answer || typeof answer !== 'object') return answer;
  const o = answer as Record<string, unknown>;
  const keys = Object.keys(o);
  if (o.op === 'moveNpc' && typeof o.key === 'string') return { moveNpc: { npc: o.key, to: o.to } };
  if (keys.length === 2 && typeof o.op === 'string' && (OPS as readonly string[]).includes(o.op) && 'key' in o) return { [o.op]: o.key };
  return Object.fromEntries(keys.map((k) => [k, fromWire(o[k])]));
}
