import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import '../src/actions/index.ts';
import { runAction } from '../src/actions/registry.ts';
import { fixedLooks, readCastFixes } from '../src/scene/cast-fixes.ts';
import { Events } from '../src/studio/events.ts';
import { Jobs } from '../src/studio/jobs.ts';
import { WorldFiles } from '../src/world/files.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-diorama.mjs', import.meta.url));
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-cast-'));
  roots.push(root);
  const dir = path.join(root, 'w');
  fs.mkdirSync(path.join(dir, 'cast'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify({
    title: 'Quay', pitch: 'A small quay on a river at dusk.', style: 'gouache, muted river colours', start: 'dock',
    hero: { key: 'wren', looks: 'a keeper in a yellow oilskin' },
    places: [{ key: 'dock', shows: 'a dock at dusk', mood: 'calm', exits: [], things: [{ key: 'ferryman', role: 'npc', looks: 'an old ferryman with a lantern' }] }],
  }));
  fs.writeFileSync(path.join(dir, 'cast', 'wren.png'), 'x');
  const events = new Events();
  const jobs = new Jobs(events, { bin: FAKE });
  return { root, dir, jobs, ctx: (by: 'user' | 'agent') => ({ by, root, events, jobs }) };
}

test('cast_status lists the hero and every NPC with what exists for them', async () => {
  const { ctx } = world();
  const cast = (await runAction('cast_status', { slug: 'w' }, ctx('user'))) as { key: string; role: string; place: string | null; figure: unknown; voice: unknown }[];
  expect(cast.map((c) => [c.key, c.role, c.place])).toEqual([['wren', 'hero', null], ['ferryman', 'npc', 'dock']]);
  expect(cast[0].figure).toMatchObject({ file: 'cast/wren.png' });
  expect(cast[1].figure).toBeNull();
  expect(cast[1].voice).toBeNull();
});

test('cast_redo keeps the new looks and counts takes; voice_set keeps the voice; both run as jobs', async () => {
  const { root, ctx } = world();
  const job = (await runAction('cast_redo', { slug: 'w', key: 'ferryman', looks: 'a young ferrywoman in a green coat' }, ctx('user'))) as { id: string; args: string[] };
  expect(job.args).toEqual(['cast', 'w', 'ferryman']);
  await ctx('user').jobs.wait(job.id);
  const take = (await runAction('cast_redo', { slug: 'w', key: 'ferryman', anotherTake: true }, ctx('user'))) as { id: string };
  await ctx('user').jobs.wait(take.id);
  const files = new WorldFiles('w', root);
  expect(readCastFixes(files).ferryman).toEqual({ looks: 'a young ferrywoman in a green coat', take: 1 });
  expect(fixedLooks(files, { key: 'ferryman', looks: 'old' }).looks).toContain('ferrywoman');
  const voice = (await runAction('voice_set', { slug: 'w', key: 'ferryman', voice: 'abc', style: 0.4 }, ctx('user'))) as { id: string; args: string[] };
  await ctx('user').jobs.wait(voice.id);
  expect(voice.args).toEqual(['voices', 'w']);
  expect(readCastFixes(files).ferryman.voice).toEqual({ voice: 'abc', why: 'chosen by the person', style: 0.4 });
  await expect(runAction('cast_redo', { slug: 'w', key: 'nobody', anotherTake: true }, ctx('user'))).rejects.toThrow(/no hero or NPC/);
  await expect(runAction('cast_redo', { slug: 'w', key: 'wren' }, ctx('user'))).rejects.toThrow(/anotherTake/);
});

test('a locked world refuses the agent\'s cast changes', async () => {
  const { ctx } = world();
  await runAction('lock_set', { slug: 'w', locked: true }, ctx('user'));
  await expect(runAction('cast_redo', { slug: 'w', key: 'wren', anotherTake: true }, ctx('agent'))).rejects.toThrow(/locked/);
});
