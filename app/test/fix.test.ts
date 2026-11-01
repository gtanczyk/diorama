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
import { History } from '../src/studio/history.ts';
import { placeTrouble } from '../src/studio/trouble.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-diorama.mjs', import.meta.url));
const roots: string[] = [];
const pools: Jobs[] = [];
afterEach(async () => {
  for (const jobs of pools.splice(0)) {
    jobs.stopAll();
    await Promise.all(jobs.list().map((j) => jobs.wait(j.id)));
  }
  roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true }));
});

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-fix-'));
  roots.push(root);
  const dir = path.join(root, 'w');
  const place = path.join(dir, 'places', 'dock');
  fs.mkdirSync(place, { recursive: true });
  for (const f of ['blockin.png', 'painting.png', 'masks.json']) fs.writeFileSync(path.join(place, f), 'x');
  const events = new Events();
  const jobs = new Jobs(events, { bin: FAKE });
  pools.push(jobs);
  return { root, dir, place, events, jobs, ctx: (by: 'user' | 'agent') => ({ by, root, events, jobs }) };
}

test('undo and redo include the source correction, and queued fixes wait for their own snapshot', async () => {
  const { root, dir, place, events } = world();
  const history = new History(dir);
  const jobs = new Jobs(events, { bin: FAKE, beforeStart: (j) => { history.snapshot(j.label, j.by); } }); pools.push(jobs);
  const ctx = { root, events, jobs, by: 'user' as const };
  const first = await runAction('mask_fix', { slug: 'w', place: 'dock', thing: 'boat', phrase: 'red boat' }, ctx) as { id: string };
  const second = await runAction('mask_fix', { slug: 'w', place: 'dock', thing: 'boat', phrase: 'blue boat' }, ctx) as { id: string };
  expect(readCorrections(place).things.boat.phrase).toBe('red boat');
  await jobs.wait(second.id);
  expect((await jobs.wait(first.id)).state).toBe('done');
  expect(readCorrections(place).things.boat.phrase).toBe('blue boat');
  await runAction('history_undo', { slug: 'w' }, ctx);
  expect(readCorrections(place).things.boat.phrase).toBe('red boat');
  await runAction('history_redo', { slug: 'w' }, ctx);
  expect(readCorrections(place).things.boat.phrase).toBe('blue boat');
});

test('world_build resumes at a place failure even when later global steps are recorded', async () => {
  const { dir, ctx, jobs } = world();
  fs.writeFileSync(path.join(dir, 'world.json'), '{}');
  const { STEPS } = await import('../src/commands/build.ts');
  fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify({ steps: Object.fromEntries(STEPS.map((s) => [s, {}])), places: [{ place: 'dock', from: 'paint' }] }));
  const job = await runAction('world_build', { slug: 'w' }, ctx('user')) as { id: string; args: string[] };
  expect(job.args).toEqual(['build', 'w', '--from', 'paint']);
  await jobs.wait(job.id);
  const explicit = await runAction('world_build', { slug: 'w', from: 'derive' }, ctx('user')) as { id: string; args: string[] };
  expect(explicit.args[3]).toBe('derive'); await jobs.wait(explicit.id);
});

test('retrying a cancelled queued fix still applies its correction once it starts', async () => {
  const { ctx, jobs, place } = world();
  const first = jobs.start('w', ['test', 'w'], 'first', 'user');
  const queued = await runAction('mask_fix', { slug: 'w', place: 'dock', thing: 'boat', phrase: 'blue boat' }, ctx('user')) as { id: string };
  jobs.cancel(queued.id);
  expect(readCorrections(place).things.boat).toBeUndefined();
  await jobs.wait(first.id);
  const retried = await runAction('job_retry', { id: queued.id }, ctx('user')) as { id: string };
  await jobs.wait(retried.id);
  expect(readCorrections(place).things.boat.phrase).toBe('blue boat');
});

test('queued additions reserve distinct names before either correction is written', async () => {
  const { dir, ctx, jobs } = world();
  fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify({ title: 'W', pitch: 'A small test world for things.', style: 'ink and watercolour', start: 'dock', hero: { key: 'ola', looks: 'a girl in a yellow coat' }, places: [{ key: 'dock', shows: 'a wooden dock at night', mood: 'calm', things: [{ key: 'crate', role: 'prop', looks: 'a wooden crate' }], exits: [] }] }));
  const blocker = jobs.start('w', ['sleep', 'w'], 'waiting', 'user');
  const first = await runAction('thing_add', { slug: 'w', place: 'dock', looks: 'a blue bench' }, ctx('user')) as { thing: string; job: { id: string } };
  const second = await runAction('thing_add', { slug: 'w', place: 'dock', looks: 'a blue bench' }, ctx('user')) as { thing: string; job: { id: string } };
  expect([first.thing, second.thing]).toEqual(['blue-bench', 'blue-bench-2']);
  jobs.cancel(blocker.id); await jobs.wait(blocker.id); await jobs.wait(second.job.id);
});

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
  const { place, ctx, jobs } = world();
  const job = (await runAction('mask_fix', { slug: 'w', place: 'dock', thing: 'boat', phrase: 'rowing boat' }, ctx('agent'))) as { id: string; args: string[] };
  expect(job.args).toEqual(['build', 'w', '--from', 'masks', '--to', 'verify', '--place', 'dock']);
  await runAction('floor_cells', { slug: 'w', place: 'dock', floor: 'deck', add: ['c3'], remove: ['A1'] }, ctx('user'));
  await runAction('floor_cells', { slug: 'w', place: 'dock', floor: 'deck', add: ['a1'] }, ctx('user'));
  const stand = (await runAction('stand_set', { slug: 'w', place: 'dock', thing: 'boat', at: [400, 700] }, ctx('user'))) as { id: string; args: string[] };
  expect(stand.args[3]).toBe('derive');
  const paint = (await runAction('repaint_region', { slug: 'w', place: 'dock', region: [0, 0, 100, 100], fix: 'a brass lantern' }, ctx('user'))) as { id: string; args: string[] };
  expect(paint.args[3]).toBe('paint');
  await jobs.wait(paint.id);
  await expect(runAction('floor_cells', { slug: 'w', place: 'dock', floor: 'deck', add: ['Z99'] }, ctx('user'))).rejects.toThrow(/grid cell/);

  const saved = readCorrections(place);
  expect(saved.things.boat).toEqual({ phrase: 'rowing boat', stand: [400, 700], strokes: [] });
  expect(saved.floors.deck).toEqual({ add: ['C3', 'A1'], remove: [], strokes: [] });
  expect(saved.repaint).toEqual([{ region: [0, 0, 100, 100], fix: 'a brass lantern' }]);

  const cleared = (await runAction('corrections_clear', { slug: 'w', place: 'dock' }, ctx('user'))) as { id: string; args: string[] };
  expect(cleared.args[3]).toBe('paint');
  await jobs.wait(cleared.id);
  expect(readCorrections(place)).toEqual({ things: {}, floors: {}, repaint: [], added: {} });
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

test('budget counts only calls sent, prices Meta calls by what they used, and counts Meta credits down', async () => {
  const { root, dir, ctx } = world();
  process.env.XDG_CONFIG_HOME = path.join(root, 'config');
  fs.mkdirSync(path.join(dir, 'memo'), { recursive: true });
  const now = new Date().toISOString();
  const lines = [
    // An old Spark call without its cost takes the list estimate; a new one says what it cost.
    { at: now, model: 'spark', hit: false }, { at: now, model: 'spark', hit: false, usd: 0.002, via: 'contributor' }, { at: now, model: 'spark', hit: true },
    // Answered by another model: not on Meta's bill.
    { at: now, model: 'spark', hit: false, usd: 0.01, via: 'claude-sonnet-5-5' },
    { at: '2020-01-01T00:00:00Z', model: 'muse', hit: false },
    { at: now, model: 'sound', hit: false },
  ];
  fs.writeFileSync(path.join(dir, 'memo', 'calls.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
  type B = { total: { calls: Record<string, number>; usd: number; priced: boolean }; today: { calls: Record<string, number> }; elsewhere: { calls: number; usd: number }; creditsLeft: number | null; over: boolean };
  const b = (await runAction('budget', {}, ctx('user'))) as B;
  expect(b.total.calls).toEqual({ spark: 2, muse: 1, sound: 1 });
  expect(b.today.calls).toEqual({ spark: 2, sound: 1 });
  expect(b.elsewhere).toEqual({ calls: 1, usd: 0.01 });
  expect(b.total).toMatchObject({ usd: 0.04, priced: false });
  await runAction('budget_set', { prices: { sound: 0.02 }, limitUsd: 0.05, creditsUsd: 10 }, ctx('user'));
  const priced = (await runAction('budget', {}, ctx('user'))) as B;
  expect(priced.total).toMatchObject({ usd: 0.06, priced: true });
  expect(priced.over).toBe(true);
  // Calls before the balance was typed in are already in it.
  expect(priced.creditsLeft).toBe(10);
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

test('a retry goes back to the step where a place was set aside, not the last step the build reached', async () => {
  const { ctx, jobs, dir } = world();
  const first = jobs.start('w', ['fail', 'w'], 'build', 'user');
  await jobs.wait(first.id, 5000);
  Object.assign(jobs.get(first.id)!, { args: ['build', 'w', '--from', 'layout', '--to', 'weather'], step: 'weather' });
  fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify({ steps: {}, places: [{ place: 'dock', ok: false, from: 'paint', errors: [], flagged: [], issues: [] }, { place: 'quay', ok: true, errors: [], flagged: [], issues: [] }] }));
  const again = (await runAction('job_retry', { id: first.id }, ctx('user'))) as { id: string; args: string[] };
  expect(again.args).toEqual(['build', 'w', '--from', 'paint', '--to', 'weather']);
  await jobs.wait(again.id, 5000);
});

test('paint_words keeps the painter\'s wording in corrections.json and repaints the place; only painted keys', async () => {
  const { dir, place, ctx, jobs } = world();
  fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify({
    title: 'Quay', pitch: 'A small quay on a river at dusk.', style: 'gouache, muted river colours', start: 'dock',
    hero: { key: 'wren', looks: 'a keeper in a yellow oilskin' },
    places: [{ key: 'dock', shows: 'a dock between bare trees', mood: 'calm', exits: [], things: [{ key: 'swing', role: 'prop', looks: 'a swing frame' }, { key: 'franek', role: 'npc', looks: 'an old man' }] }],
  }));
  await expect(runAction('paint_words', { slug: 'w', place: 'dock', looks: { franek: 'an old man in a grey coat' } }, ctx('user'))).rejects.toThrow(/no painted thing or floor franek/);
  const job = (await runAction('paint_words', { slug: 'w', place: 'dock', shows: 'a dock between leafless trees', looks: { swing: 'a faded swing frame, its two seats resting low' } }, ctx('agent'))) as { id: string; args: string[] };
  expect(job.args).toEqual(['build', 'w', '--from', 'paint', '--to', 'verify', '--place', 'dock']);
  await jobs.wait(job.id, 5000);
  expect(readCorrections(place).words).toEqual({ shows: 'a dock between leafless trees', looks: { swing: 'a faded swing frame, its two seats resting low' }, by: 'person' });
  const cleared = (await runAction('corrections_clear', { slug: 'w', place: 'dock' }, ctx('user'))) as { id: string; args: string[] };
  expect(cleared.args).toContain('paint');
  await jobs.wait(cleared.id, 5000);
  expect(readCorrections(place).words).toBeUndefined();
});

test('a place still being cut out is not trouble because the sound and voices beside it finished first', () => {
  const { dir, place } = world();
  fs.rmSync(path.join(place, 'masks.json'));
  fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify({ steps: { layout: {}, paint: {}, cast: {}, sound: {}, voices: {} } }));
  expect(placeTrouble(dir, 'dock')).toBeNull();
  fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify({ steps: { paint: {}, derive: {} } }));
  expect(placeTrouble(dir, 'dock')).toMatchObject({ from: 'masks', why: 'masks never finished here (no masks.json)' });
});

test('Fix it rebuilds a place from the step it never got past, and hands a built but unplayable place to the agent', async () => {
  const { dir, place, ctx, jobs, events } = world();
  fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify({
    title: 'Quay', pitch: 'A small quay on a river at dusk.', style: 'gouache, muted river colours', start: 'dock',
    hero: { key: 'wren', looks: 'a keeper in a yellow oilskin' },
    places: [{ key: 'dock', shows: 'a dock between leafless trees', mood: 'calm', exits: [], things: [{ key: 'swing', role: 'prop', looks: 'a swing frame' }] }],
  }));
  // The playground's state: an old build set it aside at verify on a missing file; it was never painted.
  fs.rmSync(path.join(place, 'painting.png'));
  fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify({ steps: { paint: {}, weather: {} }, places: [{ place: 'dock', ok: false, from: 'verify', errors: ['STEP_FAILED verify: missing geometry.json: run the step before this one'] }] }));
  const status = (await runAction('world_status', { slug: 'w' }, ctx('user'))) as { placeDetail: Array<{ trouble: { why: string; from: string } }> };
  expect(status.placeDetail[0].trouble).toMatchObject({ from: 'paint', why: 'paint never finished here (no painting.png)' });
  const r = (await runAction('place_fix', { slug: 'w', place: 'dock' }, ctx('user'))) as { did: string; job: { id: string; args: string[] } };
  expect(r.did).toBe('rebuild');
  expect(r.job.args).toEqual(['build', 'w', '--from', 'paint', '--to', 'verify', '--place', 'dock']);
  await jobs.wait(r.job.id, 5000);
  // A refusal reads as one line, not the API's JSON.
  fs.writeFileSync(path.join(place, 'painting.png'), 'x');
  fs.writeFileSync(path.join(place, 'geometry.json'), 'x');
  fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify({ steps: {}, places: [{ place: 'dock', ok: false, from: 'paint', errors: ['STEP_FAILED paint: POST /images/edits: 400 {"error":{"code":"content_policy_violation"}}'] }] }));
  const refused = (await runAction('world_status', { slug: 'w' }, ctx('user'))) as { placeDetail: Array<{ trouble: { why: string } }> };
  expect(refused.placeDetail[0].trouble.why).toBe('paint: the image safety filter refused the painting');
  // Built through, verify finds an error: the agent gets it.
  fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify({ steps: {} }));
  fs.writeFileSync(path.join(place, 'verify.json'), JSON.stringify({ ok: false, errors: [{ code: 'FLOOR_UNREACHABLE', key: '0', detail: 'none reachable' }], flags: [] }));
  const asked: unknown[] = [];
  events.subscribe((e) => e.type === 'repair.ask' && asked.push(e));
  expect(await runAction('place_fix', { slug: 'w', place: 'dock' }, ctx('user'))).toMatchObject({ did: 'agent', why: 'FLOOR_UNREACHABLE 0: none reachable' });
  expect(asked).toHaveLength(1);
  await expect(runAction('place_fix', { slug: 'w', place: 'dock' }, ctx('agent'))).rejects.toThrow(/playbook/);
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
  const moved = placeNpcs(layout, new Set(['franek']), { things: { franek: { at: [200, 300], strokes: [] }, boat: { at: [0, 0], strokes: [] } }, floors: {}, repaint: [], added: {} });
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

test('a prop comes off a place\'s list (kept painted or painted out) and a painted one goes on; story things stay', async () => {
  const { dir, place, ctx, jobs } = world();
  fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify({ title: 'W', pitch: 'A small test world for things.', style: 'ink and watercolour', start: 'dock', hero: { key: 'ola', looks: 'a girl in a yellow coat' }, places: [{ key: 'dock', shows: 'a wooden dock at night', mood: 'calm', things: [
    { key: 'crate', role: 'prop', looks: 'a wooden crate' }, { key: 'oar', role: 'item', looks: 'an old oar' }, { key: 'net', role: 'prop', looks: 'a fishing net' }], exits: [] }] }));
  fs.writeFileSync(path.join(place, 'masks.json'), JSON.stringify({ things: { crate: { box: [100, 500, 200, 600] } } }));
  fs.writeFileSync(path.join(dir, 'story.json'), JSON.stringify({ interactions: [{ place: 'dock', thing: 'net', verb: 'take', say: 'Tangled.', do: [] }] }));
  const kept = (await runAction('thing_remove', { slug: 'w', place: 'dock', thing: 'crate' }, ctx('user'))) as { args: string[] };
  expect(kept.args[3]).toBe('masks');
  await expect(runAction('thing_remove', { slug: 'w', place: 'dock', thing: 'oar' }, ctx('user'))).rejects.toThrow(/story_redo/);
  await expect(runAction('thing_remove', { slug: 'w', place: 'dock', thing: 'net' }, ctx('user'))).rejects.toThrow(/story uses/);
  const out = (await runAction('thing_remove', { slug: 'w', place: 'dock', thing: 'crate', paintOut: true }, ctx('user'))) as { id: string; args: string[] };
  expect(out.args[3]).toBe('paint');
  await jobs.wait(out.id);
  expect(readCorrections(place).repaint[0]).toEqual({ region: [84, 484, 216, 616], fix: 'Paint out the wooden crate: continue what is behind it, add nothing new' });
  const added = (await runAction('thing_add', { slug: 'w', place: 'dock', looks: 'The red bench', kind: 'standing' }, ctx('agent'))) as { thing: string; job: { id: string } };
  await jobs.wait(added.job.id);
  expect(added.thing).toBe('red-bench');
  const { WorldFiles } = await import('../src/world/files.ts');
  const things = new WorldFiles('w', path.dirname(dir)).world().places[0].things.map((t) => `${t.key}:${t.role}`);
  expect(things).toEqual(['oar:item', 'net:prop', 'red-bench:prop']);
});

test('missing layout has readable status and both retry and guidance repair can create the place', async () => {
  const { dir, place, ctx, jobs } = world();
  fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify({
    title: 'Quay', pitch: 'A small quay on a river at dusk.', style: 'gouache, muted river colours', start: 'dock',
    hero: { key: 'wren', looks: 'a keeper in a yellow oilskin' },
    places: [{ key: 'dock', shows: 'a dock between leafless trees', mood: 'calm', exits: [], things: [{ key: 'swing', role: 'prop', looks: 'a swing frame' }] }],
  }));
  fs.rmSync(place, { recursive: true });
  fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify({ steps: {}, places: [{ place: 'dock', ok: false, from: 'layout', errors: ['STEP_FAILED layout: swing too small'], issues: [{ code: 'STEP_FAILED', key: 'layout', detail: 'swing too small' }] }] }));
  const status = await runAction('place_status', { slug: 'w', place: 'dock' }, ctx('agent'));
  expect(status).toMatchObject({ playable: false, pictures: { painting: null }, errors: [{ detail: 'swing too small' }] });
  const retry = await runAction('place_fix', { slug: 'w', place: 'dock' }, ctx('agent')) as { job: { id: string; args: string[] } };
  expect(retry.job.args).toEqual(['build', 'w', '--from', 'layout', '--to', 'verify', '--place', 'dock']);
  await jobs.wait(retry.job.id);
  fs.rmSync(place, { recursive: true });
  const repair = await runAction('layout_fix', { slug: 'w', place: 'dock', guidance: 'Make the swing at least 40 pixels wide.' }, ctx('agent')) as { id: string; args: string[] };
  await jobs.wait(repair.id);
  expect(readCorrections(place).layout?.guidance).toBe('Make the swing at least 40 pixels wide.');
  await expect(runAction('layout_fix', { slug: 'w', place: 'unknown', guidance: 'Make a new place.' }, ctx('agent'))).rejects.toThrow(/no place/);
  fs.writeFileSync(path.join(place, 'painting.png'), 'x');
  await expect(runAction('layout_fix', { slug: 'w', place: 'dock', guidance: 'Change the room.' }, ctx('agent'))).rejects.toThrow(/already has a painting/);
});

test('composition failure has a new-take retry and can simplify a plan while preserving old paid art', async () => {
  const { dir, place, ctx, jobs } = world();
  fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify({
    title: 'Quay', pitch: 'A small quay on a river at dusk.', style: 'gouache on paper', start: 'dock',
    hero: { key: 'wren', looks: 'a keeper in a yellow coat' },
    places: [{ key: 'dock', shows: 'a small quay', mood: 'calm', exits: [], things: [{ key: 'boat', role: 'prop', looks: 'a boat' }] }],
  }));
  fs.writeFileSync(path.join(place, 'painting-layout.json'), JSON.stringify({ ok: false, attempts: [{ issues: ['stairs disconnected'] }] }));
  fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify({ steps: {}, places: [{ place: 'dock', ok: false, from: 'paint', errors: ['PAINT_LAYOUT_MISMATCH'], issues: [{ code: 'STEP_FAILED', key: 'paint', detail: 'PAINT_LAYOUT_MISMATCH' }] }] }));
  const first = await runAction('paint_retry', { slug: 'w', place: 'dock' }, ctx('agent')) as { id: string; args: string[] };
  expect(first.args).toEqual(['build', 'w', '--from', 'paint', '--to', 'verify', '--place', 'dock']);
  await jobs.wait(first.id); expect(readCorrections(place).take).toBe(1);
  const second = await runAction('place_fix', { slug: 'w', place: 'dock' }, ctx('user')) as { job: { id: string } };
  await jobs.wait(second.job.id); expect(readCorrections(place).take).toBe(2);
  const fix = await runAction('layout_fix', { slug: 'w', place: 'dock', guidance: 'Keep one broad connected pier and put the stairs directly on it.' }, ctx('agent')) as { id: string };
  await jobs.wait(fix.id); expect(readCorrections(place).layout?.guidance).toContain('connected pier');
  expect(fs.readFileSync(path.join(place, 'painting.png'), 'utf8')).toBe('x');
  fs.writeFileSync(path.join(place, 'painting-layout.json'), JSON.stringify({ ok: true, attempts: [{ issues: [] }] }));
  await expect(runAction('layout_fix', { slug: 'w', place: 'dock', guidance: 'Change the room.' }, ctx('agent'))).rejects.toThrow('already has a painting');
});
