import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import '../src/actions/index.ts';
import { runAction } from '../src/actions/registry.ts';
import { emptyMask, maskArea } from '../src/image/mask.ts';
import { brush, correctCells, correctSpots, readCorrections } from '../src/scene/corrections.ts';
import { Events } from '../src/studio/events.ts';
import { Jobs } from '../src/studio/jobs.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-diorama.mjs', import.meta.url));
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-fix-'));
  roots.push(root);
  const dir = path.join(root, 'w');
  const place = path.join(dir, 'places', 'dock');
  fs.mkdirSync(place, { recursive: true });
  for (const f of ['blockin.png', 'painting.png', 'masks.json']) fs.writeFileSync(path.join(place, f), 'x');
  const events = new Events();
  const jobs = new Jobs(events, { bin: FAKE });
  return { root, dir, place, events, jobs, ctx: (by: 'user' | 'agent') => ({ by, root, events, jobs }) };
}

test('brush strokes add and erase round dabs along their line', () => {
  const m = brush(emptyMask(100, 100), [{ mode: 'add', radius: 5, points: [[10, 50], [90, 50]] }]);
  expect(m.bits[50 * 100 + 50]).toBe(1);
  expect(m.bits[40 * 100 + 50]).toBe(0);
  const area = maskArea(m);
  expect(area).toBeGreaterThan(80 * 10 * 0.9);
  const rubbed = brush(m, [{ mode: 'erase', radius: 5, points: [[50, 50]] }]);
  expect(rubbed.bits[50 * 100 + 50]).toBe(0);
  expect(maskArea(rubbed)).toBeLessThan(area);
});

test('the person\'s phrase, box and kind replace Spark\'s; floor cells are added and removed', () => {
  const fixes = readCorrections('/nowhere');
  fixes.things.boat = { phrase: 'rowing boat', box: [10, 20, 300, 2000], kind: 'standing', strokes: [] };
  const spots = correctSpots({ boat: { box: null, kind: 'flat', phrase: 'boat', also: 'skiff' }, can: { box: [1, 2, 3, 4], kind: 'on-top', phrase: 'can' } }, fixes);
  expect(spots.boat).toEqual({ box: [10, 20, 300, 896], kind: 'standing', phrase: 'rowing boat', also: undefined });
  expect(spots.can.phrase).toBe('can');
  fixes.floors.deck = { add: ['c3'], remove: ['A1'], strokes: [] };
  expect(correctCells({ deck: ['A1', 'B1'], sand: ['D4'] }, fixes)).toEqual({ deck: ['B1', 'C3'], sand: ['D4'] });
});

test('fix actions keep their fix in corrections.json and rebuild only that place from the right step', async () => {
  const { place, ctx } = world();
  const job = (await runAction('mask_fix', { slug: 'w', place: 'dock', thing: 'boat', phrase: 'rowing boat' }, ctx('agent'))) as { id: string; args: string[] };
  expect(job.args).toEqual(['build', 'w', '--from', 'masks', '--to', 'verify', '--place', 'dock']);
  await runAction('floor_cells', { slug: 'w', place: 'dock', floor: 'deck', add: ['c3'], remove: ['A1'] }, ctx('user'));
  await runAction('floor_cells', { slug: 'w', place: 'dock', floor: 'deck', add: ['a1'] }, ctx('user'));
  const stand = (await runAction('stand_set', { slug: 'w', place: 'dock', thing: 'boat', at: [400, 700] }, ctx('user'))) as { id: string; args: string[] };
  expect(stand.args[3]).toBe('derive');
  const paint = (await runAction('repaint_region', { slug: 'w', place: 'dock', region: [0, 0, 100, 100], fix: 'a brass lantern' }, ctx('user'))) as { id: string; args: string[] };
  expect(paint.args[3]).toBe('paint');
  await expect(runAction('floor_cells', { slug: 'w', place: 'dock', floor: 'deck', add: ['Z99'] }, ctx('user'))).rejects.toThrow(/grid cell/);

  const saved = readCorrections(place);
  expect(saved.things.boat).toEqual({ phrase: 'rowing boat', stand: [400, 700], strokes: [] });
  expect(saved.floors.deck).toEqual({ add: ['C3', 'A1'], remove: [], strokes: [] });
  expect(saved.repaint).toEqual([{ region: [0, 0, 100, 100], fix: 'a brass lantern' }]);

  const cleared = (await runAction('corrections_clear', { slug: 'w', place: 'dock' }, ctx('user'))) as { id: string; args: string[] };
  expect(cleared.args[3]).toBe('paint');
  expect(readCorrections(place)).toEqual({ things: {}, floors: {}, repaint: [] });
});

test('a locked place refuses the agent\'s fixes there, but not elsewhere', async () => {
  const { dir, ctx } = world();
  fs.mkdirSync(path.join(dir, 'places', 'pier'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'places', 'pier', 'painting.png'), 'x');
  await runAction('lock_set', { slug: 'w', place: 'dock', locked: true }, ctx('user'));
  await expect(runAction('mask_fix', { slug: 'w', place: 'dock', thing: 'boat', kind: 'wall' }, ctx('agent'))).rejects.toThrow(/locked dock/);
  await runAction('mask_fix', { slug: 'w', place: 'pier', thing: 'post', kind: 'standing' }, ctx('agent'));
  await runAction('mask_fix', { slug: 'w', place: 'dock', thing: 'boat', kind: 'wall' }, ctx('user'));
});

test('notes wait as pending until closed with a reply, and can be reopened', async () => {
  const { ctx, events } = world();
  const seen: string[] = [];
  events.subscribe((e) => seen.push(e.type));
  const note = (await runAction('feedback_add', { slug: 'w', place: 'dock', point: [300, 500], text: 'the boat floats above the water' }, ctx('user'))) as { id: string };
  await runAction('feedback_add', { slug: 'w', text: 'too dark overall' }, ctx('user'));
  expect(((await runAction('feedback_pending', { slug: 'w' }, ctx('agent'))) as unknown[]).length).toBe(2);
  await runAction('feedback_done', { slug: 'w', id: note.id, reply: 'boxed the boat lower; masks rebuilt' }, ctx('agent'));
  const pending = (await runAction('feedback_pending', { slug: 'w' }, ctx('agent'))) as Array<{ text: string }>;
  expect(pending.map((n) => n.text)).toEqual(['too dark overall']);
  await runAction('feedback_reopen', { slug: 'w', id: note.id }, ctx('user'));
  expect(((await runAction('feedback_pending', { slug: 'w' }, ctx('agent'))) as unknown[]).length).toBe(2);
  expect(seen).toContain('feedback.changed');
});

test('budget counts only calls sent, and prices them where a price is set', async () => {
  const { root, dir, ctx } = world();
  process.env.XDG_CONFIG_HOME = path.join(root, 'config');
  fs.mkdirSync(path.join(dir, 'memo'), { recursive: true });
  const now = new Date().toISOString();
  const lines = [
    { at: now, model: 'spark', hit: false }, { at: now, model: 'spark', hit: false }, { at: now, model: 'spark', hit: true },
    { at: '2020-01-01T00:00:00Z', model: 'muse', hit: false },
  ];
  fs.writeFileSync(path.join(dir, 'memo', 'calls.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
  const b = (await runAction('budget', {}, ctx('user'))) as { total: { calls: Record<string, number>; priced: boolean }; today: { calls: Record<string, number> } };
  expect(b.total.calls).toEqual({ spark: 2, muse: 1 });
  expect(b.today.calls).toEqual({ spark: 2 });
  expect(b.total.priced).toBe(false);
  await runAction('budget_set', { prices: { spark: 0.01, muse: 0.04 }, limitUsd: 0.05 }, ctx('user'));
  const priced = (await runAction('budget', {}, ctx('user'))) as { total: { usd: number; priced: boolean }; over: boolean };
  expect(priced.total).toMatchObject({ usd: 0.06, priced: true });
  expect(priced.over).toBe(true);
  delete process.env.XDG_CONFIG_HOME;
});

test('a failed build is retried from the step it failed on', async () => {
  const { ctx, jobs } = world();
  const first = jobs.start('w', ['fail', 'w', '--from', 'world', '--to', 'verify'], 'build', 'user');
  const done = await jobs.wait(first.id, 5000);
  expect(done.state).toBe('failed');
  // The fake's command is not 'build', so its args come back as they were.
  const again = (await runAction('job_retry', { id: first.id }, ctx('user'))) as { id: string; args: string[] };
  expect(again.args).toEqual(first.args);
  const real = jobs.get(first.id)!;
  Object.assign(real, { args: ['build', 'w', '--from', 'world', '--to', 'verify'], step: 'masks' });
  await jobs.wait(again.id, 5000);
  const third = (await runAction('job_retry', { id: first.id }, ctx('user'))) as { id: string; args: string[] };
  expect(third.args).toEqual(['build', 'w', '--from', 'masks', '--to', 'verify']);
  await jobs.wait(third.id, 5000);
});

test('the agent gets three fixes of a place that leave it unplayable; then it must hand over to the person', async () => {
  const { ctx, jobs } = world();
  process.env.FAKE_FAIL = '1';
  try {
    for (let i = 0; i < 3; i++) {
      const job = (await runAction('floor_cells', { slug: 'w', place: 'dock', floor: 'deck', add: [`C${i + 1}`] }, ctx('agent'))) as { id: string };
      expect((await jobs.wait(job.id)).state).toBe('failed');
    }
    await expect(runAction('floor_cells', { slug: 'w', place: 'dock', floor: 'deck', add: ['C9'] }, ctx('agent'))).rejects.toThrow(/tell the person/);
    // The person is never held back.
    await runAction('floor_cells', { slug: 'w', place: 'dock', floor: 'deck', add: ['C9'] }, ctx('user'));
  } finally {
    delete process.env.FAKE_FAIL;
  }
});

test('a moved NPC stands where the person put it, sized for the depth there; npc_move takes only NPCs', async () => {
  const { placeNpcs } = await import('../src/scene/corrections.ts');
  const layout = { horizon: 100, things: [{ key: 'franek', x: 300, footY: 500, width: 80, height: 200 }, { key: 'boat', x: 600, footY: 600, width: 200, height: 100 }] };
  const moved = placeNpcs(layout, new Set(['franek']), { things: { franek: { at: [200, 300], strokes: [] }, boat: { at: [0, 0], strokes: [] } }, floors: {}, repaint: [] });
  expect(moved.things[0]).toEqual({ key: 'franek', x: 200, footY: 300, width: 40, height: 100 });
  expect(moved.things[1]).toEqual(layout.things[1]);
  const { dir, ctx } = world();
  fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify({
    title: 'Quay', pitch: 'A small quay on a river at dusk.', style: 'gouache, muted river colours', start: 'dock',
    hero: { key: 'wren', looks: 'a keeper in a yellow oilskin' },
    places: [{ key: 'dock', shows: 'a dock at dusk', mood: 'calm', exits: [], things: [{ key: 'franek', role: 'npc', looks: 'an old ferryman' }, { key: 'boat', role: 'prop', looks: 'a boat' }] }],
  }));
  const job = (await runAction('npc_move', { slug: 'w', place: 'dock', npc: 'franek', at: [200, 300] }, ctx('user'))) as { args: string[] };
  expect(job.args).toEqual(['build', 'w', '--from', 'derive', '--to', 'verify', '--place', 'dock']);
  expect(readCorrections(path.join(dir, 'places', 'dock')).things.franek.at).toEqual([200, 300]);
  await expect(runAction('npc_move', { slug: 'w', place: 'dock', npc: 'boat', at: [1, 1] }, ctx('user'))).rejects.toThrow(/no NPC/);
});
