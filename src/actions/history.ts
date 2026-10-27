// Undo and locks.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { History } from '../studio/history.ts';
import { agentBlocked, readLocks, writeLocks } from '../studio/locks.ts';
import { Slug } from '../world/schema.ts';
import { ActionError, defineAction } from './registry.ts';

const worldDir = (root: string, slug: string) => {
  const dir = path.join(root, slug);
  if (!fs.existsSync(dir)) throw new ActionError(404, `no world ${slug} yet`);
  return dir;
};

defineAction({
  name: 'history_list',
  reads: true,
  description: 'Snapshots of a world, newest first: one before every job and every undo, with what changed after each.',
  input: z.object({ slug: Slug, limit: z.number().int().min(1).max(200).optional() }),
  async run({ slug, limit }, ctx) {
    const history = new History(worldDir(ctx.root, slug));
    const all = history.list();
    return all.slice(0, limit ?? 30).map((s, i) => {
      // What the action after this snapshot changed: up to the next snapshot (newer), or to the last one we have.
      const after = i > 0 ? all[i - 1].files : null;
      const diff = after ? History.diff(s.files, after) : null;
      return { id: s.id, at: s.at, label: s.label, by: s.by, files: Object.keys(s.files).length, ...(diff && { added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length, sample: [...diff.changed, ...diff.added].slice(0, 6) }) };
    });
  },
});

defineAction({
  name: 'history_undo',
  description: 'Put a world back as it was in a snapshot (default: the latest, i.e. undo the last job). The current state is snapshotted first, so this can be undone too.',
  input: z.object({ slug: Slug, id: z.string().optional() }),
  async run({ slug, id }, ctx) {
    const dir = worldDir(ctx.root, slug);
    const busy = ctx.jobs.busy(slug);
    if (busy) throw new ActionError(409, `${busy.label} is ${busy.state}; stop it before undoing`);
    const blocked = agentBlocked(dir, ctx.by);
    if (blocked) throw new ActionError(423, blocked);
    const history = new History(dir);
    const target = id ?? history.list()[0]?.id;
    if (!target) throw new ActionError(404, `${slug} has no snapshots yet`);
    const label = history.list().find((x) => x.id === target)?.label;
    const result = history.restore(target, ctx.by);
    ctx.events.publish('history.undo', { world: slug, id: target, by: ctx.by, label, ...result });
    return { id: target, ...result };
  },
});

defineAction({
  name: 'history_redo',
  description: 'Take back the last undo, right after it: the world returns to how it was before the undo.',
  input: z.object({ slug: Slug }),
  async run({ slug }, ctx) {
    const dir = worldDir(ctx.root, slug);
    const busy = ctx.jobs.busy(slug);
    if (busy) throw new ActionError(409, `${busy.label} is ${busy.state}; stop it before redoing`);
    const blocked = agentBlocked(dir, ctx.by);
    if (blocked) throw new ActionError(423, blocked);
    const history = new History(dir);
    const last = history.list()[0];
    if (!last?.label.startsWith('before undo to ')) throw new ActionError(409, 'nothing to redo: redo works right after an undo');
    const result = history.restore(last.id, ctx.by, 'redo');
    ctx.events.publish('history.undo', { world: slug, id: last.id, by: ctx.by, redo: true, ...result });
    return { id: last.id, ...result };
  },
});

defineAction({
  name: 'lock_set',
  description: 'Lock or unlock a world or one place, so the agent leaves it alone. The agent may lock, but only the person can unlock.',
  input: z.object({ slug: Slug, place: Slug.optional(), locked: z.boolean() }),
  async run({ slug, place, locked }, ctx) {
    const dir = worldDir(ctx.root, slug);
    const locks = readLocks(dir);
    const current = place ? locks.places[place] : locks.world;
    if (!locked && current && ctx.by === 'agent') throw new ActionError(423, 'only the person can unlock');
    const lock = { by: ctx.by, at: new Date().toISOString() };
    if (place) {
      if (locked) locks.places[place] = lock;
      else delete locks.places[place];
    } else if (locked) locks.world = lock;
    else delete locks.world;
    writeLocks(dir, locks);
    ctx.events.publish('lock.changed', { world: slug, place, locked, by: ctx.by });
    return locks;
  },
});
