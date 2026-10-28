// Notes: the person points at a place and says what is wrong; the note waits until the agent (or the
// person) works it off and says what was done. Kept in worlds/<slug>/studio/feedback.json.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Slug } from '../world/schema.ts';
import { ActionError, defineAction, type ActionContext } from './registry.ts';

export type Note = { id: string; at: string; by: string; place?: string; point?: [number, number]; text: string; state: 'open' | 'done'; reply?: string; doneAt?: string };

const file = (root: string, slug: string) => path.join(root, slug, 'studio', 'feedback.json');

export function readNotes(root: string, slug: string): Note[] {
  try {
    return JSON.parse(fs.readFileSync(file(root, slug), 'utf8')) as Note[];
  } catch {
    return [];
  }
}

function writeNotes(ctx: ActionContext, slug: string, notes: Note[]) {
  fs.mkdirSync(path.dirname(file(ctx.root, slug)), { recursive: true });
  fs.writeFileSync(file(ctx.root, slug), `${JSON.stringify(notes, null, 2)}\n`);
  ctx.events.publish('feedback.changed', { world: slug, open: notes.filter((n) => n.state === 'open').length });
}

defineAction({
  name: 'feedback_add',
  description: 'Leave a note on a world or on a spot of a place (painting pixels) for later: what looks or plays wrong. The person\'s own notes come from the Studio; '
    + 'as the agent, add one only when the person asks you to note something, never as a way to report what you could not fix (say that in your answer).',
  input: z.object({ slug: Slug, text: z.string().min(2).max(2000), place: z.string().min(1).optional(), point: z.tuple([z.number(), z.number()]).optional() }),
  async run({ slug, text, place, point }, ctx) {
    if (!fs.existsSync(path.join(ctx.root, slug))) throw new ActionError(404, `no world ${slug} yet`);
    const note: Note = { id: randomBytes(3).toString('hex'), at: new Date().toISOString(), by: ctx.by, ...(place && { place }), ...(point && { point }), text, state: 'open' };
    writeNotes(ctx, slug, [...readNotes(ctx.root, slug), note]);
    return note;
  },
});

defineAction({
  name: 'feedback_pending',
  reads: true,
  description: 'The person\'s open notes on a world: what they want fixed, where (place and painting point). Work each off with the fix tools, then feedback_done.',
  input: z.object({ slug: Slug }),
  async run({ slug }, ctx) {
    return readNotes(ctx.root, slug).filter((n) => n.state === 'open');
  },
});

defineAction({
  name: 'feedback_list',
  reads: true,
  description: 'Every note on a world, open and done, with the replies.',
  input: z.object({ slug: Slug }),
  async run({ slug }, ctx) {
    return readNotes(ctx.root, slug);
  },
});

defineAction({
  name: 'feedback_done',
  description: 'Close a note with one sentence on what was done about it (or why nothing was).',
  input: z.object({ slug: Slug, id: z.string().min(1), reply: z.string().min(2).max(500) }),
  async run({ slug, id, reply }, ctx) {
    const notes = readNotes(ctx.root, slug);
    const note = notes.find((n) => n.id === id);
    if (!note) throw new ActionError(404, `no note ${id} on ${slug}`);
    Object.assign(note, { state: 'done', reply, doneAt: new Date().toISOString() });
    writeNotes(ctx, slug, notes);
    return note;
  },
});

defineAction({
  name: 'feedback_reopen',
  description: 'Open a closed note again, when the fix did not do it.',
  input: z.object({ slug: Slug, id: z.string().min(1) }),
  async run({ slug, id }, ctx) {
    const notes = readNotes(ctx.root, slug);
    const note = notes.find((n) => n.id === id);
    if (!note) throw new ActionError(404, `no note ${id} on ${slug}`);
    Object.assign(note, { state: 'open' });
    writeNotes(ctx, slug, notes);
    return note;
  },
});
